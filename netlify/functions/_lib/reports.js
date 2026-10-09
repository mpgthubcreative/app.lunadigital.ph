// Distributor Reports (Phase 11), server side.
//
// 1. applyRollup(): called INSIDE the order / payment / expense
//    transactions to keep reportRollups/{day} and /{month} in step
//    (increments only, no read). Server-only collection: no browser rule.
// 2. buildReport(): GET /api/reports aggregation. Reads only summary
//    documents (financialMetrics, metrics, reportRollups) for the range,
//    the current gauges, and bounded lookups (top customers, low stock).
//    Money is only computed and returned for dashboard.financials holders;
//    each section needs its source module + view permission.
// 3. rebuildRollups(): recomputes every rollup from the source records
//    (backfill, and the oracle the tests compare the incremental ones to).

import { rangePlan, sumMetricDocs, diffRollup, addRollup, orderContribution, paymentContribution, expenseContribution, ROLLUP_SECTIONS, REPORT_TOP_ROWS, WALK_IN_KEY } from "../../../shared/reports.js";
import { financialSummary, grossMarginPct } from "../../../shared/finance.js";
import { OPERATIONAL_COUNTERS, FINANCIAL_COUNTERS } from "../../../shared/metrics.js";
import { canUseModule } from "../../../shared/modules.js";

const ROLLUPS = "reportRollups";

// ---------- 1. Writes ----------

function incrementTree(FieldValue, delta) {
  const out = {};
  for (const [section, entries] of Object.entries(delta)) {
    out[section] = {};
    for (const [key, v] of Object.entries(entries)) {
      const e = {};
      for (const [f, val] of Object.entries(v)) e[f] = typeof val === "number" ? FieldValue.increment(val) : val;
      out[section][key] = e;
    }
  }
  return out;
}

// delta: { products?, customers?, paymentMethods?, expenseCategories?, expenseMethods? }
// (from diffRollup / the *Contribution helpers). Posts to the day and its month.
export function applyRollup(tx, { tenant, FieldValue, day, delta }) {
  if (!delta || !Object.keys(delta).length) return;
  const body = incrementTree(FieldValue, delta);
  const stamp = FieldValue.serverTimestamp();
  tx.set(tenant.doc(ROLLUPS, day), { period: "day", id: day, ...body, updatedAt: stamp }, { merge: true });
  tx.set(tenant.doc(ROLLUPS, day.slice(0, 7)), { period: "month", id: day.slice(0, 7), ...body, updatedAt: stamp }, { merge: true });
}

// The rollup lines of a fulfilled order (cost snapshot from orderCosts).
export function linesFor(order, costLines) {
  const cost = new Map((costLines || []).map((l) => [l.lineId, l.costConsumed]));
  return order.items.map((l) => ({ productId: l.productId, quantity: l.quantity, lineSubtotal: l.lineSubtotal, costConsumed: cost.get(l.lineId) ?? 0, sku: l.sku, name: l.name, unit: l.unit }));
}

export const fulfilledOrderContribution = (order, costLines) => orderContribution({ lines: linesFor(order, costLines), discount: order.discount || 0, customerId: order.customerId ?? null });

// ---------- 2. Reads ----------

const sumFields = sumMetricDocs;

async function readDocs(tenant, collection, ids) {
  const snaps = await Promise.all(ids.map((id) => tenant.doc(collection, id).get()));
  return new Map(snaps.map((s, i) => [ids[i], s.exists ? s.data() : null]));
}

// perms: the caller's effective permission map; entitlements: snapshot.
export async function buildReport({ db, tenant, from, to, permissions, entitlements }) {
  const can = (moduleId) => canUseModule({ entitlements, permissions }, moduleId);
  const financials = permissions["dashboard.financials"] === true;
  const plan = rangePlan(from, to);
  const ids = [...new Set(plan.buckets.flatMap((b) => b.docs))];

  const [fin, ops, rolls, currentOps, currentFin] = await Promise.all([
    financials ? readDocs(tenant, "financialMetrics", ids) : null,
    readDocs(tenant, "metrics", ids),
    readDocs(tenant, ROLLUPS, ids),
    tenant.doc("metrics", "current").get(),
    financials ? tenant.doc("financialMetrics", "current").get() : null,
  ]);

  const OPS = Object.keys(OPERATIONAL_COUNTERS);
  const FIN = Object.keys(FINANCIAL_COUNTERS);
  // Every metrics write fills all counters, so a document that exists is a
  // real (possibly zero) value; a period with no document at all is "no
  // data" (null), never a fabricated 0.
  const bucketOps = (b) => sumFields(b.docs.map((id) => ops.get(id)), OPS);
  const bucketFin = (b) => (fin ? sumFields(b.docs.map((id) => fin.get(id)), FIN) : null);

  const totalOps = sumFields([...ops.values()], OPS);
  const totalFin = fin ? sumFields([...fin.values()], FIN) : null;
  const rollup = {};
  for (const r of rolls.values()) if (r) addRollup(rollup, r);
  const anyRollup = [...rolls.values()].some(Boolean);

  const report = {
    range: { from, to, granularity: plan.granularity },
    access: { financials },
    overview: {
      ordersCreated: totalOps ? totalOps.orderCount ?? 0 : null,
      fulfilledOrders: totalOps ? totalOps.fulfilledOrders ?? 0 : null,
      cancelledOrders: totalOps ? totalOps.cancelledOrders ?? 0 : null,
    },
    series: plan.buckets.map((b) => {
      const o = bucketOps(b);
      const f = bucketFin(b);
      const s = f ? financialSummary(f) : null;
      return {
        period: b.period,
        ordersCreated: o ? o.orderCount ?? 0 : null,
        fulfilledOrders: o ? o.fulfilledOrders ?? 0 : null,
        ...(financials ? { netSales: s ? s.netSales : null, grossProfit: s ? s.grossProfit : null, operatingExpenses: s ? s.operatingExpenses : null, paymentsReceived: s ? s.paymentsReceived : null } : {}),
      };
    }),
    sections: [],
  };

  if (financials) {
    const s = totalFin ? financialSummary(totalFin) : null;
    Object.assign(report.overview, {
      grossSales: s ? s.grossSales : null,
      discounts: s ? s.discounts : null,
      returns: s ? s.returns : null,
      netSales: s ? s.netSales : null,
      cogs: s ? s.cogs : null,
      grossProfit: s ? s.grossProfit : null,
      grossMarginPct: s ? grossMarginPct(s) : null,
      operatingExpenses: s ? s.operatingExpenses : null,
      estimatedOperatingProfit: s ? s.estimatedOperatingProfit : null,
      paymentsReceived: s ? s.paymentsReceived : null,
      averageOrderValue: s && s.netSales !== null && totalOps && totalOps.fulfilledOrders ? Math.round(s.netSales / totalOps.fulfilledOrders) : null,
    });
  }

  // Payments (payments module + payments.view)
  if (can("payments")) {
    const cur = currentOps.exists ? currentOps.data() : null;
    const methods = Object.entries(rollup.paymentMethods || {})
      .filter(([, v]) => v.count || v.amount)
      .map(([method, v]) => ({ method, count: v.count, ...(financials ? { amount: v.amount } : {}) }))
      .sort((a, b) => (financials ? b.amount - a.amount : b.count - a.count));
    report.payments = {
      methods: anyRollup ? methods : null,
      unpaidOrdersNow: cur && Number.isSafeInteger(cur.unpaidOrders) ? cur.unpaidOrders : null,
      ...(financials ? { unpaidBalanceNow: currentFin && currentFin.exists && Number.isSafeInteger(currentFin.data().receivablesOutstanding) ? currentFin.data().receivablesOutstanding : null } : {}),
    };
    report.sections.push("payments");
  }

  // Products sold (orders module + orders.view); costs need financials.
  if (can("orders")) {
    const rows = Object.entries(rollup.products || {})
      .filter(([, v]) => v.qty || v.netSales || v.cogs)
      .map(([productId, v]) => ({ productId, sku: v.sku, name: v.name, unit: v.unit, qty: v.qty, ...(financials ? { netSales: v.netSales, cogs: v.cogs, grossProfit: v.netSales - v.cogs } : {}) }))
      .sort((a, b) => (financials ? b.netSales - a.netSales : b.qty - a.qty) || (a.name || "").localeCompare(b.name || ""));
    report.products = { rows: anyRollup ? rows.slice(0, REPORT_TOP_ROWS) : null, total: rows.length };
    report.sections.push("products");
  }

  // Customers (customers module + customers.view, and orders.view).
  if (can("customers") && can("orders")) {
    const entries = Object.entries(rollup.customers || {}).filter(([, v]) => v.orders || v.netSales);
    entries.sort((a, b) => (financials ? b[1].netSales - a[1].netSales : b[1].orders - a[1].orders) || a[0].localeCompare(b[0]));
    const top = entries.slice(0, REPORT_TOP_ROWS);
    const saved = await readDocs(tenant, "customers", top.map(([k]) => k).filter((k) => k !== WALK_IN_KEY));
    report.customers = {
      rows: anyRollup
        ? top.map(([key, v]) => {
            const c = key === WALK_IN_KEY ? null : saved.get(key);
            return {
              customerId: key === WALK_IN_KEY ? null : key,
              walkIn: key === WALK_IN_KEY,
              name: key === WALK_IN_KEY ? null : c ? c.name : null,
              orders: v.orders,
              ...(financials ? { netSales: v.netSales, outstandingBalanceNow: c ? c.stats?.outstandingBalance ?? 0 : null } : {}),
              lastOrderNumber: c ? c.stats?.lastOrderNumber ?? null : null,
            };
          })
        : null,
      total: entries.length,
    };
    report.sections.push("customers");
  }

  // Expenses (expenses module + expenses.view). Amounts here are the
  // Expenses page's own figures (expenses.view already shows them).
  if (can("expenses")) {
    const rows = (section) =>
      Object.entries(rollup[section] || {})
        .filter(([, v]) => v.count || v.amount)
        .map(([key, v]) => ({ key, count: v.count, amount: v.amount }))
        .sort((a, b) => b.amount - a.amount);
    report.expenses = anyRollup ? { categories: rows("expenseCategories"), methods: rows("expenseMethods") } : { categories: null, methods: null };
    report.sections.push("expenses");
  }

  // Low stock now (inventory module + inventory.view), bounded.
  if (can("inventory")) {
    const snap = await tenant.collection("products").where("isLowStock", "==", true).limit(REPORT_TOP_ROWS).get();
    report.lowStock = snap.docs.map((d) => ({ productId: d.id, sku: d.data().sku, name: d.data().name, unit: d.data().unit, available: d.data().available, reorderLevel: d.data().reorderLevel }));
    report.sections.push("inventory");
  }
  return report;
}

// ---------- 3. Rebuild from source records ----------

// Recomputes every rollup for one business from its fulfilled orders (+
// orderCosts), live payments and active expenses, then replaces the
// stored rollups. Run when the business is quiet (an event committed
// between the reads and the writes could be overwritten).
export async function computeRollupsFromSource({ tenant }) {
  const byId = new Map();
  const add = (day, contribution) => {
    for (const id of [day, day.slice(0, 7)]) addRollup((byId.get(id) || byId.set(id, {}).get(id)), contribution);
  };
  const orders = await tenant.collection("orders").where("fulfillmentStatus", "==", "fulfilled").get();
  for (const d of orders.docs) {
    const o = d.data();
    const costs = await tenant.doc("orderCosts", d.id).get();
    if (o.fulfilledDay) add(o.fulfilledDay, fulfilledOrderContribution(o, costs.exists ? costs.data().lines : []));
  }
  for (const d of (await tenant.collection("payments").get()).docs) {
    const p = d.data();
    if (p.state !== "voided" && p.receivedDay) add(p.receivedDay, paymentContribution(p));
  }
  for (const d of (await tenant.collection("expenses").where("status", "==", "active").get()).docs) {
    const e = d.data();
    add(e.date, expenseContribution(e));
  }
  return byId;
}

export async function rebuildRollups({ db, tenant, FieldValue }) {
  const fresh = await computeRollupsFromSource({ tenant });
  const existing = (await tenant.collection(ROLLUPS).get()).docs.map((d) => d.id);
  const ops = [];
  for (const id of existing) if (!fresh.has(id)) ops.push((b) => b.delete(tenant.doc(ROLLUPS, id)));
  for (const [id, r] of fresh) ops.push((b) => b.set(tenant.doc(ROLLUPS, id), { period: id.length === 10 ? "day" : "month", id, ...emptyFill(r), updatedAt: FieldValue.serverTimestamp(), rebuiltAt: FieldValue.serverTimestamp() }));
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach((op) => op(batch));
    await batch.commit();
  }
  return { documents: fresh.size, removed: existing.filter((id) => !fresh.has(id)).length };
}

const emptyFill = (r) => Object.fromEntries(ROLLUP_SECTIONS.map((s) => [s, r[s] || {}]));

export { diffRollup, paymentContribution, expenseContribution };
