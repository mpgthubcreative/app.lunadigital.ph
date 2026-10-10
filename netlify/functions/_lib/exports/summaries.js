// Summary workbooks (Phase 12.5): Dashboard and Reports. Both read only
// the existing summary documents (no transaction lists, apart from the
// Baby / Wedding live sections) and reuse the screens' own logic, so a
// workbook matches what the screen shows:
//   Dashboard  the visible widgets (resolveDashboard) over the selected
//              period (dashboardDocuments + combineDashboardDocs +
//              widgetValue) and the CURRENT gauges.
//   Reports    buildReport() itself: sections and money exactly as the
//              Reports API would return them to this caller.
//
// Phase 18.6: ONE worksheet per download. Summaries have many kinds of
// figures, so each is a "long" table: one row per figure with a Section
// column (filter on it), the period, the item, and the value in the column
// for its kind (a count, a quantity, a peso amount...). No totals row:
// rows of different sections don't add up.

import { resolveDashboard, dashboardDocuments, dashboardCounts, widgetSourceKey, combineDashboardDocs, widgetValue } from "../../../../shared/dashboard.js";
import { rangePlan } from "../../../../shared/reports.js";
import { PAYMENT_METHODS } from "../../../../shared/payments.js";
import { EXPENSE_METHODS, expenseCategoryLabel } from "../../../../shared/expenses.js";
import { UNITS, formatQuantity } from "../../../../shared/quantity.js";
import { buildReport } from "../reports.js";
import { snapshotWorkspaceTemplateId, workspaceSectionLabel } from "../../../../shared/workspaces.js";
import { expensesQuery, scheduledPaymentsQuery, categoriesQuery } from "../../../../shared/list-queries.js";
import { BUDGET_DOC_ID, sortCategories, payerTotals, upcomingPart } from "../../../../shared/baby.js";
import { weddingDashboardRows } from "./wedding.js";

const NO_DATA = "No data yet";
const period = (from, to) => (from === to ? from : `${from} to ${to}`);

// The dashboard's columns: a value goes in Count or Amount by its format.
const DASHBOARD_COLUMNS = [
  { header: "Section", format: "text", width: 26, value: (r) => r.section },
  { header: "Period / date", format: "text", width: 22, value: (r) => r.period ?? null },
  { header: "Item", format: "text", width: 34, value: (r) => r.item },
  { header: "Count", format: "integer", width: 10, value: (r) => r.count ?? null },
  { header: "Amount", format: "money", width: 14, value: (r) => r.amount ?? null },
  { header: "Note", format: "text", width: 44, value: (r) => r.note ?? null },
];
// A widget's value as a row: money -> Amount, else Count; missing -> "No data yet".
const widgetRow = (section, w, value, extra = {}) => {
  const base = { section, item: w.label, period: extra.period ?? null };
  if (value === null || value === undefined) return { ...base, note: NO_DATA };
  return { ...base, ...(w.format === "money" ? { amount: value } : { count: value }), note: extra.note ?? null };
};

// ---------- Dashboard ----------

async function dashboard({ tenant, filters, permissions, entitlements, now, today, readByIds, readRows }) {
  const { from, to } = filters;
  const widgets = resolveDashboard({ entitlements, permissions }).filter((w) => w.kind === "stat" && w.format !== "list");
  const periodWidgets = widgets.filter((w) => w.section === "period");
  const currentWidgets = widgets.filter((w) => w.section === "current");
  const plan = dashboardDocuments(widgets, { from, to }, today);
  const read = new Map();
  for (const d of plan) read.set(d.source, { ...d, docs: await readByIds(d.collection, d.ids) });
  // Live counts (as of export time), e.g. overdue tasks against the business's today.
  for (const c of dashboardCounts(widgets, today)) {
    let q = tenant.collection(c.collection);
    for (const [f, op, v] of c.where) q = q.where(f, op, v);
    read.set(c.key, { count: (await q.count().get()).data().count });
  }
  const valueFor = (w, ids = null) => {
    const r = read.get(widgetSourceKey(w));
    if (!r) return null;
    if (w.source === "count") return widgetValue(w, { count: r.count });
    return widgetValue(w, combineDashboardDocs(w.source, (ids || r.ids).map((id) => r.docs.get(id) ?? null)));
  };

  const workspace = snapshotWorkspaceTemplateId(entitlements);
  const rows = [];
  const range = period(from, to);
  for (const w of periodWidgets) rows.push(widgetRow("Selected period", w, valueFor(w), { period: range, note: w.hint || null }));
  const buckets = rangePlan(from, to).buckets;
  const byLabel = buckets.length && buckets[0].period.length === 7 ? "By month" : "By day";
  if (buckets.length > 1) for (const b of buckets) for (const w of periodWidgets) rows.push(widgetRow(byLabel, w, valueFor(w, b.docs), { period: b.period }));
  const nowLabel = workspaceSectionLabel(workspace, "current", "Current operations");
  for (const w of currentWidgets) rows.push(widgetRow(`${nowLabel} (now)`, w, valueFor(w), { note: w.hint || "As of export time" }));

  if (workspace === "bridal-expense") {
    rows.push(...(await weddingDashboardRows({ filters, permissions, today, readRows, readByIds })));
    return { rowCount: rows.length, table: { name: "Dashboard", columns: DASHBOARD_COLUMNS, rows }, note: "Selected-period spending comes from Luna's daily spending summaries. The wedding plan (budget, supplier balances, tasks, RSVPs) is live at export time." };
  }
  if (workspace === "baby-expense") {
    rows.push(...(await babyDashboardRows({ filters, permissions, readRows, readByIds })));
    return { rowCount: rows.length, table: { name: "Dashboard", columns: DASHBOARD_COLUMNS, rows }, note: "Who paid and what's still to pay are live at export time. A shared expense is split by payer, never counted twice." };
  }
  return { rowCount: rows.length, table: { name: "Dashboard", columns: DASHBOARD_COLUMNS, rows }, note: "Selected-period figures come from Luna's daily summaries (the same as Reports). Current operations are live at export time." };
}

// Baby Dashboard (Phase 18.6): who paid (now), the period's expenses and
// what's still to pay (now), each only with its view permission. Never a
// Distributor row.
async function babyDashboardRows({ filters, permissions, readRows, readByIds }) {
  const can = (p) => permissions[p] === true;
  const rows = [];
  const cats = can("budget.view") || can("expenses.view") || can("schedule.view") ? sortCategories(await readRows("expenseCategories", categoriesQuery())) : [];
  const names = new Map(cats.map((c) => [c.id, c.name]));
  const catOf = (r) => names.get(r.category) ?? r.categoryName ?? "";
  if (can("budget.view")) {
    const doc = (await readByIds("budgets", [BUDGET_DOC_ID])).get(BUDGET_DOC_ID) ?? null;
    for (const p of payerTotals(doc)) rows.push({ section: "Who paid (now)", item: p.name, amount: p.amount, note: p.key ? null : "Expenses recorded without a payer" });
  }
  if (can("expenses.view"))
    for (const e of await readRows("expenses", expensesQuery({ status: "active", from: filters.from, to: filters.to })))
      rows.push({ section: "Expenses in the period", period: e.date, item: `${catOf(e)}${e.payee ? ` · ${e.payee}` : ""}`, amount: e.amount, note: [e.notes, Array.isArray(e.paidBy) && e.paidBy.length ? `Paid by ${e.paidBy.map((p) => p.name).join(" + ")}` : null].filter(Boolean).join(" · ") || null });
  if (can("schedule.view"))
    for (const s of await readRows("scheduledPayments", scheduledPaymentsQuery({ status: "upcoming" })))
      rows.push({ section: "Still to pay (now)", period: s.dueDate, item: `${s.description} · ${catOf(s)}`, amount: upcomingPart(s), note: (s.paidAmount ?? 0) > 0 ? "Part paid: only the unpaid part" : null });
  return rows;
}

// ---------- Reports ----------

const payMethod = (k) => PAYMENT_METHODS[k]?.label ?? k;
const expMethod = (k) => EXPENSE_METHODS[k]?.label ?? k;
const unitLabel = (u) => UNITS[u]?.label ?? u ?? "";

// One aligned header for every report section; money columns only for
// callers who may see money (buildReport already hides it otherwise).
const reportColumns = (fin) => [
  { header: "Section", format: "text", width: 22, value: (r) => r.section },
  { header: "Period / date", format: "text", width: 14, value: (r) => r.period ?? null },
  { header: "Item", format: "text", width: 32, value: (r) => r.item },
  { header: "Count", format: "integer", width: 9, value: (r) => r.count ?? null },
  { header: "Quantity", format: "quantity", width: 10, value: (r) => r.qty ?? null },
  ...(fin
    ? [
        { header: "Net sales", format: "money", width: 13, value: (r) => r.netSales ?? null },
        { header: "Cost of products sold (COGS)", format: "money", width: 15, value: (r) => r.cogs ?? null },
        { header: "Gross profit", format: "money", width: 13, value: (r) => r.grossProfit ?? null },
        { header: "Amount", format: "money", width: 13, value: (r) => r.amount ?? null },
        { header: "Percent", format: "percent", width: 9, value: (r) => r.percent ?? null },
      ]
    : []),
  { header: "Note", format: "text", width: 40, value: (r) => r.note ?? null },
];

async function reports({ db, tenant, filters, permissions, entitlements }) {
  const { from, to } = filters;
  const r = await buildReport({ db, tenant, from, to, permissions, entitlements });
  const fin = r.access.financials === true;
  const o = r.overview;
  const range = period(from, to);
  const rows = [];
  const ov = (item, key, value, note = null) => rows.push({ section: "Overview", period: range, item, ...(value === null || value === undefined ? { note: [NO_DATA, note].filter(Boolean).join(" · ") } : { [key]: value, note }) });
  ov("Orders created", "count", o.ordersCreated);
  ov("Fulfilled orders", "count", o.fulfilledOrders);
  ov("Cancelled orders", "count", o.cancelledOrders);
  if (fin) {
    ov("Gross sales", "amount", o.grossSales);
    ov("Discounts", "amount", o.discounts);
    ov("Returns", "amount", o.returns);
    ov("Net sales", "netSales", o.netSales, "Gross sales − discounts − returns");
    ov("Cost of products sold (COGS)", "cogs", o.cogs, "The cost recorded when each order was fulfilled");
    ov("Gross profit", "grossProfit", o.grossProfit, "Net sales − cost of products sold");
    ov("Gross margin", "percent", o.grossMarginPct === null ? null : o.grossMarginPct / 100);
    ov("Average order value", "amount", o.averageOrderValue);
    ov("Operating expenses", "amount", o.operatingExpenses);
    ov("Estimated operating profit", "amount", o.estimatedOperatingProfit, "Gross profit − operating expenses (an estimate, not net income)");
    ov("Payments received", "amount", o.paymentsReceived);
  }
  if (r.payments) {
    rows.push({ section: "Overview", item: "Unpaid orders (now)", count: r.payments.unpaidOrdersNow, note: "Current, not for the period" });
    if (fin) rows.push({ section: "Overview", item: "Unpaid balance (now)", amount: r.payments.unpaidBalanceNow, note: "Current, not for the period" });
  }
  const by = r.range.granularity === "month" ? "Sales by month" : "Sales by day";
  for (const s of r.series || []) rows.push({ section: by, period: s.period, item: `${s.ordersCreated ?? 0} created · ${s.fulfilledOrders ?? 0} fulfilled`, count: s.fulfilledOrders, ...(fin ? { netSales: s.netSales, cogs: s.netSales === null || s.netSales === undefined || s.grossProfit === null || s.grossProfit === undefined ? null : s.cogs ?? s.netSales - s.grossProfit, grossProfit: s.grossProfit, amount: s.operatingExpenses, note: s.paymentsReceived ? `Amount = operating expenses · payments received ₱${(s.paymentsReceived / 100).toFixed(2)}` : "Amount = operating expenses" } : {}) });
  for (const p of r.products?.rows || []) rows.push({ section: "Products", item: `${p.sku} · ${p.name}`, qty: p.qty, note: unitLabel(p.unit), ...(fin ? { netSales: p.netSales, cogs: p.cogs, grossProfit: p.grossProfit } : {}) });
  for (const c of r.customers?.rows || []) rows.push({ section: "Customers", item: c.walkIn ? "Walk-in orders" : c.name, count: c.orders, ...(fin ? { netSales: c.netSales, amount: c.walkIn ? null : c.outstandingBalanceNow } : {}), note: [c.lastOrderNumber ? `Last order ${c.lastOrderNumber}` : null, fin && !c.walkIn ? "Amount = outstanding balance now" : null].filter(Boolean).join(" · ") || null });
  for (const m of r.payments?.methods || []) rows.push({ section: "Payments by method", item: payMethod(m.method), count: m.count, ...(fin ? { amount: m.amount } : {}) });
  for (const c of r.expenses?.categories || []) rows.push({ section: "Expenses by category", item: expenseCategoryLabel(c.key), count: c.count, amount: c.amount });
  for (const m of r.expenses?.methods || []) rows.push({ section: "Expenses by method", item: expMethod(m.key), count: m.count, amount: m.amount });
  for (const p of r.lowStock || []) rows.push({ section: "Low stock (now)", item: `${p.sku} · ${p.name}`, qty: p.available, note: `Stock left · reorder at ${formatQuantity(p.reorderLevel)}` });
  const capped = [r.products, r.customers].some((s) => s && s.rows && s.total > s.rows.length);
  return { rowCount: rows.length, table: { name: "Reports", columns: reportColumns(fin), rows }, note: `Same figures and sections as the Reports page for this range. Filter the Section column.${capped ? " Products and Customers list the top 50, as on the page." : ""}` };
}

export const SUMMARY_BUILDERS = Object.freeze({ dashboard, reports });
