// Dashboard widget registry. Each widget declares where its number comes
// from, who may see it, and which modules it depends on, so the dashboard
// UI holds no access or formula logic of its own.
//
// A widget is shown when the member holds its permission AND the business
// is entitled to every module in `modules` (entitled, not necessarily built
// yet: an unbuilt module's widget shows "No data yet"). Financial widgets
// need dashboard.financials, separate from dashboard.view, so staff who
// enter orders don't see profitability by default.
//
// Sources (see shared/metrics.js):
//   operational-day / financial-day   the SELECTED PERIOD (Phase 12.5): the
//       metrics / financialMetrics day (or whole-month) documents covering
//       it, summed exactly like Reports (shared/reports.js rangePlan +
//       sumMetricDocs), so Dashboard and Reports agree for the same range.
//   operational-current / financial-current   CURRENT OPERATIONS: the live
//       gauges (metrics/current, financialMetrics/current). They are never
//       reconstructed for a past period and are always labelled as "now".
//   list   a small limited query, only once `ready` (its module's data exists)

import { ESTIMATED_PROFIT_NOTE, financialSummary } from "./finance.js";
import { rangePlan, sumMetricDocs } from "./reports.js";
import { OPERATIONAL_COUNTERS, FINANCIAL_COUNTERS } from "./metrics.js";
import { snapshotWorkspaceTemplateId, getWorkspaceTemplate } from "./workspaces.js";
import { budgetSummary } from "./baby.js";
import { weddingSummary, rsvpSummary } from "./wedding.js";

export const DASHBOARD_WIDGETS = Object.freeze([
  // ---- Selected period: money (dashboard.financials) ----
  { id: "netSales", dataFrom: ["orders"], section: "period", kind: "stat", label: "Net sales", source: "financial-day", value: "netSales", format: "money", permission: "dashboard.financials", modules: ["orders"], hint: "Net of discounts and returns" },
  { id: "cogs", dataFrom: ["orders", "inventory"], section: "period", kind: "stat", label: "COGS", source: "financial-day", value: "cogs", format: "money", permission: "dashboard.financials", modules: ["orders", "inventory"], hint: "Cost of goods sold" },
  { id: "grossProfit", dataFrom: ["orders", "inventory"], section: "period", kind: "stat", label: "Gross profit", source: "financial-day", value: "grossProfit", format: "money", permission: "dashboard.financials", modules: ["orders", "inventory"], hint: "Net sales minus cost of goods sold" },
  { id: "operatingExpenses", dataFrom: ["expenses"], section: "period", kind: "stat", label: "Operating expenses", source: "financial-day", value: "operatingExpenses", format: "money", permission: "dashboard.financials", modules: ["expenses"] },
  { id: "estimatedOperatingProfit", dataFrom: ["orders", "inventory", "expenses"], section: "period", kind: "stat", label: "Estimated operating profit", source: "financial-day", value: "estimatedOperatingProfit", format: "money", permission: "dashboard.financials", modules: ["orders", "inventory", "expenses"], note: ESTIMATED_PROFIT_NOTE },
  { id: "paymentsReceived", dataFrom: ["payments"], section: "period", kind: "stat", label: "Payments received", source: "financial-day", value: "paymentsReceived", format: "money", permission: "dashboard.financials", modules: ["payments"] },
  // ---- Selected period: counts (dashboard.view) ----
  { id: "ordersToday", dataFrom: ["orders"], section: "period", kind: "stat", label: "Orders", source: "operational-day", value: "orderCount", format: "number", permission: "dashboard.view", modules: ["orders"], hint: "Orders created in the period" },

  // ---- Current operations: live gauges, always "now" ----
  { id: "receivablesOutstanding", dataFrom: ["orders"], section: "current", kind: "stat", label: "Current unpaid balance", source: "financial-current", value: "receivablesOutstanding", format: "money", permission: "dashboard.financials", modules: ["payments"], hint: "As of now" },
  { id: "unpaidOrders", dataFrom: ["orders"], section: "current", kind: "stat", label: "Current unpaid orders", source: "operational-current", value: "unpaidOrders", format: "number", permission: "dashboard.view", modules: ["orders", "payments"], hint: "As of now" },
  { id: "pendingFulfillment", dataFrom: ["orders"], section: "current", kind: "stat", label: "Awaiting fulfillment now", source: "operational-current", value: "pendingFulfillment", format: "number", permission: "dashboard.view", modules: ["orders"], hint: "As of now" },
  { id: "lowStock", dataFrom: ["inventory"], section: "current", kind: "stat", label: "Current low stock", source: "operational-current", value: "lowStockProducts", format: "number", permission: "dashboard.view", modules: ["inventory"], hint: "As of now" },

  // ---- Lists: one small, tenant-scoped, limited query each, once ready ----
  { id: "recentOrders", section: "lists", kind: "list", label: "Recent orders", source: "list", ready: true, permission: "orders.view", modules: ["orders"], query: { collection: "orders", orderBy: ["createdAt", "desc"], limit: 5 }, empty: "Orders entered in Luna will appear here." },
  { id: "lowStockItems", section: "lists", kind: "list", label: "Low-stock products (now)", source: "list", ready: true, permission: "inventory.view", modules: ["inventory"], query: { collection: "products", where: ["isLowStock", "==", true], limit: 5 }, empty: "Products at or below their reorder level will appear here." },
  // ---- Household payroll (Phase 14): small live lists ----
  { id: "attendanceToday", section: "lists", kind: "list", label: "Attendance today", source: "list", ready: true, permission: "attendance.view", modules: ["attendance"], query: { collection: "attendance", where: ["date", "==", "today"], limit: 10 }, empty: "Today's attendance will appear here once it's marked." },
  { id: "payrollsToRelease", section: "lists", kind: "list", label: "Payroll not yet paid", source: "list", ready: true, permission: "payroll.view", modules: ["payroll"], query: { collection: "payrolls", where: ["status", "==", "draft"], limit: 5 }, empty: "Prepared payrolls waiting to be paid will appear here." },
  { id: "awaitingReceipt", section: "lists", kind: "list", label: "Awaiting receipt confirmation", source: "list", ready: true, permission: "payroll.view", modules: ["payroll"], query: { collection: "payrolls", where: ["receiptStatus", "==", "awaiting"], limit: 5 }, empty: "Paid salaries the employee hasn't confirmed yet will appear here." },
  { id: "advancesNotPaid", section: "lists", kind: "list", label: "Advances not yet paid", source: "list", ready: true, permission: "advances.view", modules: ["advances"], query: { collection: "advances", where: ["status", "==", "not_yet_paid"], limit: 5 }, empty: "Advances recorded but not yet released will appear here." },
  { id: "recentActivity", section: "lists", kind: "list", label: "Recent activity", source: "list", ready: false, permission: "dashboard.view", modules: [], query: null, empty: "Staff actions and alerts will appear here." },

  // ---- Baby Expense Tracker (Phase 15): no Distributor metric is read ----
  // Selected period: Baby spending from spendingMetrics (day / month docs).
  { id: "babySpent", dataFrom: ["budget"], section: "period", kind: "stat", label: "Spent", source: "spending-day", value: "spent", format: "money", permission: "budget.view", modules: ["budget", "expenses"], hint: "Baby Expenses dated in the period" },
  { id: "babyExpenseCount", dataFrom: ["budget"], section: "period", kind: "stat", label: "Expenses recorded", source: "spending-day", value: "count", format: "number", permission: "budget.view", modules: ["budget", "expenses"] },
  // Current budget: budgets/current, always "as of now" (no history is stored).
  { id: "budgetTotal", dataFrom: ["budget"], section: "current", kind: "stat", label: "Total budget", source: "budget-current", value: "total", format: "money", permission: "budget.view", modules: ["budget"], hint: "As of now" },
  { id: "budgetSpent", dataFrom: ["budget"], section: "current", kind: "stat", label: "Total spent", source: "budget-current", value: "spent", format: "money", permission: "budget.view", modules: ["budget", "expenses"], hint: "All Baby Expenses, as of now" },
  { id: "budgetRemaining", dataFrom: ["budget"], section: "current", kind: "stat", label: "Remaining budget", source: "budget-current", value: "remaining", format: "money", permission: "budget.view", modules: ["budget", "expenses"], hint: "Total budget − total spent, as of now" },
  { id: "budgetUpcoming", dataFrom: ["budget"], section: "current", kind: "stat", label: "Upcoming payments", source: "budget-current", value: "upcoming", format: "money", permission: "budget.view", modules: ["budget", "schedule"], hint: "Scheduled, not yet paid (not counted as spent), as of now" },
  { id: "spendingByCategory", section: "lists", kind: "list", label: "Spending by category (now)", source: "list", ready: true, permission: "budget.view", modules: ["budget"], query: { collection: "expenseCategories", orderBy: ["order", "asc"], limit: 50 }, empty: "Your categories and what's been spent in each will appear here." },
  { id: "upcomingPayments", section: "lists", kind: "list", label: "Upcoming payments", source: "list", ready: true, permission: "schedule.view", modules: ["schedule"], query: { collection: "scheduledPayments", where: ["status", "==", "upcoming"], orderBy: ["dueDate", "asc"], limit: 5 }, empty: "Payments you schedule (deposits, due bills) will appear here." },
  { id: "recentExpenses", section: "lists", kind: "list", label: "Recent expenses", source: "list", ready: true, permission: "expenses.view", modules: ["expenses"], query: { collection: "expenses", where: ["status", "==", "active"], orderBy: ["date", "desc"], limit: 5 }, empty: "Baby Expenses you record will appear here." },

  // ---- Bridal / Wedding (Phase 16): no Distributor or Baby widget is read ----
  // Selected period: wedding spending from spendingMetrics (day / month docs).
  { id: "weddingSpent", dataFrom: ["budget"], section: "period", kind: "stat", label: "Wedding spending", source: "wedding-day", value: "spent", format: "money", permission: "budget.view", modules: ["budget", "expenses"], hint: "Wedding Expenses dated in the period" },
  { id: "weddingSupplierPaid", dataFrom: ["budget"], section: "period", kind: "stat", label: "Paid to suppliers", source: "wedding-day", value: "supplierPaid", format: "money", permission: "budget.view", modules: ["budget", "vendors"], hint: "Wedding Expenses for a supplier, dated in the period" },
  { id: "weddingExpenseCount", dataFrom: ["budget"], section: "period", kind: "stat", label: "Expenses recorded", source: "wedding-day", value: "count", format: "number", permission: "budget.view", modules: ["budget", "expenses"] },
  // Wedding plan, as of now (no history of these figures is stored).
  { id: "weddingBudgetTotal", dataFrom: ["budget"], section: "current", kind: "stat", label: "Total wedding budget", source: "wedding-current", value: "total", format: "money", permission: "budget.view", modules: ["budget"], hint: "As of now" },
  { id: "weddingSpentNow", dataFrom: ["budget"], section: "current", kind: "stat", label: "Total spent", source: "wedding-current", value: "spent", format: "money", permission: "budget.view", modules: ["budget", "expenses"], hint: "All Wedding Expenses, as of now" },
  { id: "weddingRemaining", dataFrom: ["budget"], section: "current", kind: "stat", label: "Remaining budget", source: "wedding-current", value: "remaining", format: "money", permission: "budget.view", modules: ["budget", "expenses"], hint: "Total budget − total spent, as of now" },
  { id: "weddingSupplierBalance", dataFrom: ["budget"], section: "current", kind: "stat", label: "Supplier balance", source: "wedding-current", value: "supplierBalance", format: "money", permission: "budget.view", modules: ["budget", "vendors"], hint: "Still owed on supplier agreements, as of now" },
  { id: "weddingUpcoming", dataFrom: ["budget"], section: "current", kind: "stat", label: "Upcoming payments", source: "wedding-current", value: "upcoming", format: "money", permission: "budget.view", modules: ["budget", "vendorpayments"], hint: "Scheduled, not yet paid (not counted as spent), as of now" },
  { id: "weddingOpenTasks", section: "current", kind: "stat", label: "Open tasks", source: "task-current", value: "open", format: "number", permission: "tasks.view", modules: ["tasks"], hint: "Not Started or In Progress, as of now" },
  { id: "weddingOverdueTasks", section: "current", kind: "stat", label: "Overdue tasks", source: "count", count: { collection: "weddingTasks", where: [["open", "==", true], ["dueDate", "<", "$today"]] }, format: "number", permission: "tasks.view", modules: ["tasks"], hint: "Open and past their due date, as of now" },
  { id: "weddingConfirmedGuests", section: "current", kind: "stat", label: "Confirmed guests (people)", source: "rsvp-current", value: "attendingSeats", format: "number", permission: "guests.view", modules: ["guests"], hint: "Sum of confirmed attendees, as of now" },
  { id: "weddingAwaitingRsvp", section: "current", kind: "stat", label: "Awaiting RSVP (invitations)", source: "rsvp-current", value: "awaiting", format: "number", permission: "guests.view", modules: ["guests"], hint: "Invitations not yet answered, as of now" },
  { id: "upcomingSupplierPayments", section: "lists", kind: "list", label: "Upcoming supplier payments", source: "list", ready: true, permission: "vendorpayments.view", modules: ["vendorpayments"], query: { collection: "supplierPayments", where: ["status", "==", "upcoming"], orderBy: ["dueDate", "asc"], limit: 5 }, empty: "Supplier payments you schedule will appear here." },
  { id: "tasksDueSoon", section: "lists", kind: "list", label: "Tasks due soon and overdue", source: "list", ready: true, permission: "tasks.view", modules: ["tasks"], query: { collection: "weddingTasks", where: ["open", "==", true], orderBy: ["dueDate", "asc"], limit: 5 }, empty: "Open tasks with a due date will appear here." },
  { id: "recentWeddingExpenses", section: "lists", kind: "list", label: "Recent wedding expenses", source: "list", ready: true, permission: "expenses.view", modules: ["expenses"], query: { collection: "expenses", where: ["status", "==", "active"], orderBy: ["date", "desc"], limit: 5 }, empty: "Wedding Expenses you record will appear here." },
  { id: "rsvpSummary", section: "lists", kind: "list", label: "RSVP summary (now)", source: "list", ready: true, permission: "guests.view", modules: ["guests"], query: { collection: "guestTotals", limit: 1 }, empty: "Add guests to see invitations, confirmations and declines." },
]);

// Which modules already WRITE metrics. A widget whose dataFrom includes a
// producer that doesn't exist yet shows "No data yet" even if its document
// field reads 0, e.g. "Paid today" before Payments, or an estimated profit
// that would silently treat unrecorded expenses as zero. Each phase that
// starts feeding metrics flips its entry.
export const LIVE_DATA_SOURCES = Object.freeze({ orders: true, inventory: true, payments: true, expenses: true, budget: true });

export function isWidgetLive(widget) {
  return (widget.dataFrom || []).every((id) => LIVE_DATA_SOURCES[id] === true);
}

// Selected period vs current operations: a current gauge never claims to
// describe a past period.
export const DASHBOARD_SECTIONS = Object.freeze([
  { id: "period", label: "Selected period" },
  { id: "current", label: "Current operations" },
  { id: "lists", label: null },
]);

// The workspace template picks WHICH widgets exist and their order (a
// template without Orders never lists an orders widget, so nothing is
// fetched for it); permissions and entitled modules then filter as before.
// A widget that depends on a module the template PLANS (e.g. Operating
// expenses) stays visible as "No data yet" (isWidgetLive), so a planned
// module never needs to be "enabled" to keep its placeholder card.
// Unknown/missing workspace: no widgets.
export function resolveDashboard({ entitlements, permissions }) {
  const modules = (entitlements && entitlements.modules) || {};
  const template = getWorkspaceTemplate(snapshotWorkspaceTemplateId(entitlements));
  if (!template) return [];
  return template.dashboard.widgets
    .map((id) => DASHBOARD_WIDGETS.find((w) => w.id === id))
    .filter((w) => w && Boolean(permissions) && permissions[w.permission] === true && w.modules.every((id) => (modules[id] === true && template.modules.includes(id)) || template.plannedModules.some((p) => p.id === id)));
}

// What the dashboard says when a workspace has no widgets to show yet.
export function dashboardEmptyState(entitlements) {
  const template = getWorkspaceTemplate(snapshotWorkspaceTemplateId(entitlements));
  return template ? template.dashboard.empty : { title: "Nothing to show yet", body: "Your dashboard fills in as your business uses Luna." };
}

// Phase 15 adds the Baby sources: spending-day (spendingMetrics, summed
// like the others) and budget-current (budgets/current).
// Phase 16 adds the Wedding sources: wedding-day (spendingMetrics with the
// supplier figure), wedding-current (budgets/current + supplier balance),
// task-current (taskTotals/current), rsvp-current (guestTotals/current) and
// "count": a live count query (dashboardCounts) for figures that depend on
// today, e.g. overdue tasks, which are derived and never stored.
const PERIOD_SOURCES = { "operational-day": "metrics", "financial-day": "financialMetrics", "spending-day": "spendingMetrics", "wedding-day": "spendingMetrics" };
const CURRENT_SOURCES = { "operational-current": "metrics", "financial-current": "financialMetrics", "budget-current": "budgets", "wedding-current": "budgets", "task-current": "taskTotals", "rsvp-current": "guestTotals" };
const SOURCE_FIELDS = { "operational-day": Object.keys(OPERATIONAL_COUNTERS), "financial-day": Object.keys(FINANCIAL_COUNTERS), "spending-day": ["spent", "count"], "wedding-day": ["spent", "count", "supplierPaid"] };

// The metric documents a set of visible widgets needs, deduped by source:
// [{ source, collection, ids }]. range: { from, to } (or one day id). A
// period reads the same day / whole-month documents as Reports (at most
// ~72 per collection for a full year); a current gauge reads one document.
// Lists aren't documents and are skipped here.
export function dashboardDocuments(widgets, range) {
  const { from, to } = typeof range === "string" ? { from: range, to: range } : range;
  const ids = [...new Set(rangePlan(from, to).buckets.flatMap((b) => b.docs))];
  const seen = new Map();
  for (const w of widgets) {
    if (PERIOD_SOURCES[w.source]) seen.set(w.source, { source: w.source, collection: PERIOD_SOURCES[w.source], ids });
    else if (CURRENT_SOURCES[w.source]) seen.set(w.source, { source: w.source, collection: CURRENT_SOURCES[w.source], ids: ["current"] });
  }
  return [...seen.values()];
}

// Count queries for visible "count" widgets, "$today" resolved to the
// business's today: [{ key: "count:<widgetId>", collection, where }].
export function dashboardCounts(widgets, today) {
  return widgets.filter((w) => w.source === "count").map((w) => ({ key: widgetSourceKey(w), collection: w.count.collection, where: w.count.where.map(([f, op, v]) => [f, op, v === "$today" ? today : v]) }));
}
// Where a widget's data lives in the fetched-source map.
export const widgetSourceKey = (w) => (w.source === "count" ? `count:${w.id}` : w.source);

// The documents read for one source -> the value the widgets use: the
// period's documents summed (null if none exist = "No data yet"), or the
// current gauge document as is.
export function combineDashboardDocs(source, docs) {
  if (SOURCE_FIELDS[source]) return sumMetricDocs(docs, SOURCE_FIELDS[source]);
  return docs.find(Boolean) ?? null;
}

// One widget's number from its source value (combineDashboardDocs), or
// null = "No data yet". Shared by the Dashboard screen and its export.
export function widgetValue(widget, data) {
  if (!isWidgetLive(widget) || !data) return null;
  // Baby: Remaining = budget − spent, computed here (never stored or sent).
  if (widget.source === "budget-current") return budgetSummary(data)[widget.value] ?? null;
  // Wedding: remaining and supplier balance computed here (never stored or sent).
  if (widget.source === "wedding-current") return weddingSummary(data)[widget.value] ?? null;
  if (widget.source === "rsvp-current") return rsvpSummary(data)[widget.value] ?? null;
  if (widget.source === "count") return Number.isSafeInteger(data.count) ? data.count : null;
  if (widget.source.startsWith("financial")) {
    const summary = widget.source === "financial-current" ? financialSummary({}, data) : financialSummary(data);
    return summary[widget.value] ?? null;
  }
  return Number.isSafeInteger(data[widget.value]) ? data[widget.value] : null;
}
