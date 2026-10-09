// Summary workbooks (Phase 12.5): Dashboard and Reports. Both read only
// the existing summary documents (no transaction lists) and reuse the
// screens' own logic, so a workbook matches what the screen shows:
//   Dashboard  the visible widgets (resolveDashboard) over the selected
//              period (dashboardDocuments + combineDashboardDocs +
//              widgetValue) and, on a separate sheet, the CURRENT gauges.
//   Reports    buildReport() itself: sections and money exactly as the
//              Reports API would return them to this caller.

import { pairsSheet, tableSheet } from "../../../../shared/exports.js";
import { resolveDashboard, dashboardDocuments, combineDashboardDocs, widgetValue } from "../../../../shared/dashboard.js";
import { rangePlan } from "../../../../shared/reports.js";
import { PAYMENT_METHODS } from "../../../../shared/payments.js";
import { EXPENSE_METHODS, expenseCategoryLabel } from "../../../../shared/expenses.js";
import { UNITS } from "../../../../shared/quantity.js";
import { buildReport } from "../reports.js";
import { snapshotWorkspaceTemplateId, workspaceSectionLabel } from "../../../../shared/workspaces.js";
import { expensesQuery, scheduledPaymentsQuery, categoriesQuery } from "../../../../shared/list-queries.js";
import { BUDGET_DOC_ID, budgetLines, sortCategories } from "../../../../shared/baby.js";
import { CATEGORY_BUDGET_COLUMNS, babyExpenseColumns, scheduleColumns } from "./baby.js";

const NO_DATA = "No data yet";
const fmt = (w) => (w.format === "money" ? "money" : "integer");
// [label, format, value, note]; a missing value is "No data yet", never 0.
const pair = (label, format, value, note) => (value === null || value === undefined ? [label, "text", NO_DATA, note] : [label, format, value, note]);
const period = (from, to) => (from === to ? from : `${from} to ${to}`);

// ---------- Dashboard ----------

async function dashboard({ filters, permissions, entitlements, timezone, now, readByIds, readRows }) {
  const { from, to } = filters;
  const widgets = resolveDashboard({ entitlements, permissions }).filter((w) => w.kind === "stat");
  const periodWidgets = widgets.filter((w) => w.section === "period");
  const currentWidgets = widgets.filter((w) => w.section === "current");
  const plan = dashboardDocuments(widgets, { from, to });
  const read = new Map();
  for (const d of plan) read.set(d.source, { ...d, docs: await readByIds(d.collection, d.ids) });
  const valueFor = (w, ids = null) => {
    const r = read.get(w.source);
    if (!r) return null;
    return widgetValue(w, combineDashboardDocs(w.source, (ids || r.ids).map((id) => r.docs.get(id) ?? null)));
  };

  const summary = pairsSheet({
    name: "Summary",
    timezone,
    rows: [["Selected period", "text", period(from, to), "Business-local days, inclusive"], ...periodWidgets.map((w) => pair(w.label, fmt(w), valueFor(w), w.hint || ""))],
  });
  const buckets = rangePlan(from, to).buckets;
  const activity = tableSheet({
    name: "Period activity",
    timezone,
    columns: [{ header: buckets.length && buckets[0].period.length === 7 ? "Month" : "Day", format: "text", width: 12, value: (b) => b.period }, ...periodWidgets.map((w) => ({ header: w.label, format: fmt(w), width: 16, value: (b) => valueFor(w, b.docs) }))],
    rows: buckets,
  });
  const sheets = [summary, activity];
  const workspace = snapshotWorkspaceTemplateId(entitlements);
  if (currentWidgets.length) {
    sheets.push(
      pairsSheet({
        name: workspaceSectionLabel(workspace, "current", "Current operations").slice(0, 31),
        timezone,
        rows: [["As of", "datetime", now, "Live figures at export time, NOT for the selected period"], ...currentWidgets.map((w) => pair(w.label, fmt(w), valueFor(w), "Current"))],
      })
    );
  }
  if (workspace === "baby-expense") {
    const baby = await babyDashboardSheets({ filters, permissions, timezone, readRows, readByIds });
    sheets.push(...baby.sheets);
    return { rowCount: periodWidgets.length + buckets.length + currentWidgets.length + baby.rowCount, sheets, note: "Selected-period spending comes from Luna's daily spending summaries. The current budget, category budgets and upcoming payments are live at export time." };
  }
  return { rowCount: periodWidgets.length + buckets.length + currentWidgets.length, sheets, note: "Selected-period figures come from Luna's daily summaries (the same as Reports). Current operations are live at export time." };
}

// Baby Dashboard (Phase 15) extra sheets, each only with its view
// permission: Category Budget (now), the selected period's Expenses, and
// the Upcoming Payments (now). Never a Distributor sheet.
async function babyDashboardSheets({ filters, permissions, timezone, readRows, readByIds }) {
  const can = (p) => permissions[p] === true;
  const sheets = [];
  let rowCount = 0;
  const cats = can("budget.view") || can("expenses.view") || can("schedule.view") ? sortCategories(await readRows("expenseCategories", categoriesQuery())) : [];
  const names = new Map(cats.map((c) => [c.id, c.name]));
  if (can("budget.view")) {
    const doc = (await readByIds("budgets", [BUDGET_DOC_ID])).get(BUDGET_DOC_ID) ?? null;
    const lines = budgetLines(doc, cats);
    rowCount += lines.length;
    sheets.push(tableSheet({ name: "Category Budget", columns: CATEGORY_BUDGET_COLUMNS, rows: lines, timezone }));
  }
  if (can("expenses.view")) {
    const rows = await readRows("expenses", expensesQuery({ status: "active", from: filters.from, to: filters.to }));
    rowCount += rows.length;
    sheets.push(tableSheet({ name: "Expenses", columns: babyExpenseColumns(names), rows, timezone }));
  }
  if (can("schedule.view")) {
    const rows = await readRows("scheduledPayments", scheduledPaymentsQuery({ status: "upcoming" }));
    rowCount += rows.length;
    sheets.push(tableSheet({ name: "Upcoming Payments", columns: scheduleColumns(names), rows, timezone }));
  }
  return { sheets, rowCount };
}

// ---------- Reports ----------

const payMethod = (k) => PAYMENT_METHODS[k]?.label ?? k;
const expMethod = (k) => EXPENSE_METHODS[k]?.label ?? k;
const unitLabel = (u) => UNITS[u]?.label ?? u ?? "";

async function reports({ db, tenant, filters, permissions, entitlements, timezone }) {
  const { from, to } = filters;
  const r = await buildReport({ db, tenant, from, to, permissions, entitlements });
  const fin = r.access.financials === true;
  const o = r.overview;
  const sheets = [];
  let rows = 0;
  const table = (name, columns, data) => {
    if (!data) return;
    rows += data.length;
    sheets.push(tableSheet({ name, columns, rows: data, timezone }));
  };

  sheets.push(
    pairsSheet({
      name: "Overview",
      timezone,
      rows: [
        ["Period", "text", period(from, to), "Business-local days, inclusive"],
        pair("Orders created", "integer", o.ordersCreated),
        pair("Fulfilled orders", "integer", o.fulfilledOrders),
        pair("Cancelled orders", "integer", o.cancelledOrders),
        ...(fin
          ? [
              pair("Gross sales", "money", o.grossSales),
              pair("Discounts", "money", o.discounts),
              pair("Returns", "money", o.returns),
              pair("Net sales", "money", o.netSales, "Gross sales − discounts − returns"),
              pair("COGS", "money", o.cogs),
              pair("Gross profit", "money", o.grossProfit),
              pair("Gross margin", "percent", o.grossMarginPct === null ? null : o.grossMarginPct / 100),
              pair("Average order value", "money", o.averageOrderValue),
              pair("Operating expenses", "money", o.operatingExpenses),
              pair("Estimated operating profit", "money", o.estimatedOperatingProfit, "Gross profit − operating expenses (not net income)"),
              pair("Payments received", "money", o.paymentsReceived),
            ]
          : []),
        ...(r.payments ? [pair("Unpaid orders (now)", "integer", r.payments.unpaidOrdersNow, "Current, not for the period"), ...(fin ? [pair("Unpaid balance (now)", "money", r.payments.unpaidBalanceNow, "Current, not for the period")] : [])] : []),
      ],
    })
  );
  table(
    "Sales",
    [
      { header: r.range.granularity === "month" ? "Month" : "Day", format: "text", width: 12, value: (s) => s.period },
      { header: "Orders created", format: "integer", value: (s) => s.ordersCreated },
      { header: "Fulfilled orders", format: "integer", value: (s) => s.fulfilledOrders },
      ...(fin
        ? [
            { header: "Net sales", format: "money", value: (s) => s.netSales },
            { header: "Gross profit", format: "money", value: (s) => s.grossProfit },
            { header: "Operating expenses", format: "money", value: (s) => s.operatingExpenses },
            { header: "Payments received", format: "money", value: (s) => s.paymentsReceived },
          ]
        : []),
    ],
    r.series
  );
  if (r.products)
    table(
      "Products",
      [
        { header: "SKU", format: "text", width: 14, value: (p) => p.sku },
        { header: "Product", format: "text", width: 30, value: (p) => p.name },
        { header: "Unit", format: "text", width: 8, value: (p) => unitLabel(p.unit) },
        { header: "Qty sold", format: "quantity", value: (p) => p.qty },
        ...(fin ? [{ header: "Net sales", format: "money", value: (p) => p.netSales }, { header: "COGS", format: "money", value: (p) => p.cogs }, { header: "Gross profit", format: "money", value: (p) => p.grossProfit }] : []),
      ],
      r.products.rows
    );
  if (r.customers)
    table(
      "Customers",
      [
        { header: "Customer", format: "text", width: 28, value: (c) => (c.walkIn ? "Walk-in orders" : c.name) },
        { header: "Orders", format: "integer", value: (c) => c.orders },
        ...(fin ? [{ header: "Net sales", format: "money", value: (c) => c.netSales }, { header: "Outstanding balance (now)", format: "money", width: 20, value: (c) => (c.walkIn ? null : c.outstandingBalanceNow) }] : []),
        { header: "Last order #", format: "text", value: (c) => c.lastOrderNumber },
      ],
      r.customers.rows
    );
  if (r.payments)
    table(
      "Payments",
      [{ header: "Method", format: "text", width: 16, value: (m) => payMethod(m.method) }, { header: "Payments", format: "integer", value: (m) => m.count }, ...(fin ? [{ header: "Amount", format: "money", value: (m) => m.amount }] : [])],
      r.payments.methods
    );
  if (r.expenses) {
    table("Expenses by category", [{ header: "Category", format: "text", width: 20, value: (c) => expenseCategoryLabel(c.key) }, { header: "Expenses", format: "integer", value: (c) => c.count }, { header: "Amount", format: "money", value: (c) => c.amount }], r.expenses.categories);
    table("Expenses by method", [{ header: "Method", format: "text", width: 16, value: (m) => expMethod(m.key) }, { header: "Expenses", format: "integer", value: (m) => m.count }, { header: "Amount", format: "money", value: (m) => m.amount }], r.expenses.methods);
  }
  if (r.lowStock)
    table(
      "Low stock (now)",
      [
        { header: "SKU", format: "text", width: 14, value: (p) => p.sku },
        { header: "Product", format: "text", width: 30, value: (p) => p.name },
        { header: "Available", format: "quantity", value: (p) => p.available },
        { header: "Reorder level", format: "quantity", value: (p) => p.reorderLevel },
      ],
      r.lowStock
    );
  const capped = [r.products, r.customers].some((s) => s && s.rows && s.total > s.rows.length);
  return { rowCount: rows, sheets, note: `Same figures and sections as the Reports page for this range.${capped ? " Products and Customers list the top 50, as on the page." : ""}` };
}

export const SUMMARY_BUILDERS = Object.freeze({ dashboard, reports });
