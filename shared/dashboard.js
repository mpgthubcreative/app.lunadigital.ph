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
//   operational-day / operational-current  metrics/{YYYY-MM-DD} / metrics/current
//   financial-day   / financial-current    financialMetrics/{YYYY-MM-DD} / financialMetrics/current
//   list   a small limited query, only once `ready` (its module's data exists)

import { ESTIMATED_PROFIT_NOTE } from "./finance.js";
import { snapshotWorkspaceTemplateId, getWorkspaceTemplate } from "./workspaces.js";

export const DASHBOARD_WIDGETS = Object.freeze([
  // ---- Financial (dashboard.financials) ----
  { id: "netSales", dataFrom: ["orders"], section: "financial", kind: "stat", label: "Today's sales", source: "financial-day", value: "netSales", format: "money", permission: "dashboard.financials", modules: ["orders"], hint: "Net of discounts and returns" },
  { id: "grossProfit", dataFrom: ["orders", "inventory"], section: "financial", kind: "stat", label: "Gross profit", source: "financial-day", value: "grossProfit", format: "money", permission: "dashboard.financials", modules: ["orders", "inventory"], hint: "Net sales minus cost of goods sold" },
  { id: "operatingExpenses", dataFrom: ["expenses"], section: "financial", kind: "stat", label: "Operating expenses", source: "financial-day", value: "operatingExpenses", format: "money", permission: "dashboard.financials", modules: ["expenses"] },
  { id: "estimatedOperatingProfit", dataFrom: ["orders", "inventory", "expenses"], section: "financial", kind: "stat", label: "Estimated operating profit", source: "financial-day", value: "estimatedOperatingProfit", format: "money", permission: "dashboard.financials", modules: ["orders", "inventory", "expenses"], note: ESTIMATED_PROFIT_NOTE },
  { id: "paymentsReceived", dataFrom: ["payments"], section: "financial", kind: "stat", label: "Paid today", source: "financial-day", value: "paymentsReceived", format: "money", permission: "dashboard.financials", modules: ["payments"] },
  { id: "receivablesOutstanding", dataFrom: ["orders"], section: "financial", kind: "stat", label: "Unpaid balance", source: "financial-current", value: "receivablesOutstanding", format: "money", permission: "dashboard.financials", modules: ["payments"] },

  // ---- Operations (dashboard.view) ----
  { id: "ordersToday", dataFrom: ["orders"], section: "operations", kind: "stat", label: "Orders today", source: "operational-day", value: "orderCount", format: "number", permission: "dashboard.view", modules: ["orders"] },
  { id: "unpaidOrders", dataFrom: ["orders"], section: "operations", kind: "stat", label: "Unpaid orders", source: "operational-current", value: "unpaidOrders", format: "number", permission: "dashboard.view", modules: ["orders", "payments"] },
  { id: "pendingFulfillment", dataFrom: ["orders"], section: "operations", kind: "stat", label: "For fulfillment / delivery", source: "operational-current", value: "pendingFulfillment", format: "number", permission: "dashboard.view", modules: ["orders"] },
  { id: "lowStock", dataFrom: ["inventory"], section: "operations", kind: "stat", label: "Low stock", source: "operational-current", value: "lowStockProducts", format: "number", permission: "dashboard.view", modules: ["inventory"] },

  // ---- Lists: one small, tenant-scoped, limited query each, once ready ----
  { id: "recentOrders", section: "lists", kind: "list", label: "Recent orders", source: "list", ready: true, permission: "orders.view", modules: ["orders"], query: { collection: "orders", orderBy: ["createdAt", "desc"], limit: 5 }, empty: "Orders entered in Luna will appear here." },
  { id: "lowStockItems", section: "lists", kind: "list", label: "Low-stock products", source: "list", ready: true, permission: "inventory.view", modules: ["inventory"], query: { collection: "products", where: ["isLowStock", "==", true], limit: 5 }, empty: "Products at or below their reorder level will appear here." },
  { id: "recentActivity", section: "lists", kind: "list", label: "Recent activity", source: "list", ready: false, permission: "dashboard.view", modules: [], query: null, empty: "Staff actions and alerts will appear here." },
]);

// Which modules already WRITE metrics. A widget whose dataFrom includes a
// producer that doesn't exist yet shows "No data yet" even if its document
// field reads 0, e.g. "Paid today" before Payments, or an estimated profit
// that would silently treat unrecorded expenses as zero. Each phase that
// starts feeding metrics flips its entry.
export const LIVE_DATA_SOURCES = Object.freeze({ orders: true, inventory: true, payments: true, expenses: false });

export function isWidgetLive(widget) {
  return (widget.dataFrom || []).every((id) => LIVE_DATA_SOURCES[id] === true);
}

export const DASHBOARD_SECTIONS = Object.freeze([
  { id: "financial", label: "Sales and profit" },
  { id: "operations", label: "Operations" },
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

const SOURCE_DOCS = {
  "operational-day": (day) => ["metrics", day],
  "operational-current": () => ["metrics", "current"],
  "financial-day": (day) => ["financialMetrics", day],
  "financial-current": () => ["financialMetrics", "current"],
};

// The metric documents a set of visible widgets needs for `day`, deduped:
// at most four document reads, whatever the business size. Lists aren't
// documents and are skipped here.
export function dashboardDocuments(widgets, day) {
  const seen = new Map();
  for (const w of widgets) {
    const make = SOURCE_DOCS[w.source];
    if (!make) continue;
    const [collection, id] = make(day);
    seen.set(`${collection}/${id}`, { source: w.source, collection, id });
  }
  return [...seen.values()];
}
