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

export const DASHBOARD_WIDGETS = Object.freeze([
  // ---- Financial (dashboard.financials) ----
  { id: "netSales", section: "financial", kind: "stat", label: "Today's sales", source: "financial-day", value: "netSales", format: "money", permission: "dashboard.financials", modules: ["orders"], hint: "Net of discounts and returns" },
  { id: "grossProfit", section: "financial", kind: "stat", label: "Gross profit", source: "financial-day", value: "grossProfit", format: "money", permission: "dashboard.financials", modules: ["orders", "inventory"], hint: "Net sales minus cost of goods sold" },
  { id: "operatingExpenses", section: "financial", kind: "stat", label: "Operating expenses", source: "financial-day", value: "operatingExpenses", format: "money", permission: "dashboard.financials", modules: ["expenses"] },
  { id: "estimatedOperatingProfit", section: "financial", kind: "stat", label: "Estimated operating profit", source: "financial-day", value: "estimatedOperatingProfit", format: "money", permission: "dashboard.financials", modules: ["orders", "inventory", "expenses"], note: ESTIMATED_PROFIT_NOTE },
  { id: "paymentsReceived", section: "financial", kind: "stat", label: "Paid today", source: "financial-day", value: "paymentsReceived", format: "money", permission: "dashboard.financials", modules: ["payments"] },
  { id: "receivablesOutstanding", section: "financial", kind: "stat", label: "Unpaid balance", source: "financial-current", value: "receivablesOutstanding", format: "money", permission: "dashboard.financials", modules: ["payments"] },

  // ---- Operations (dashboard.view) ----
  { id: "ordersToday", section: "operations", kind: "stat", label: "Orders today", source: "operational-day", value: "orderCount", format: "number", permission: "dashboard.view", modules: ["orders"] },
  { id: "unpaidOrders", section: "operations", kind: "stat", label: "Unpaid orders", source: "operational-current", value: "unpaidOrders", format: "number", permission: "dashboard.view", modules: ["orders", "payments"] },
  { id: "pendingFulfillment", section: "operations", kind: "stat", label: "For fulfillment / delivery", source: "operational-current", value: "pendingFulfillment", format: "number", permission: "dashboard.view", modules: ["orders"] },
  { id: "lowStock", section: "operations", kind: "stat", label: "Low stock", source: "operational-current", value: "lowStockProducts", format: "number", permission: "dashboard.view", modules: ["inventory"] },

  // ---- Lists: one small, tenant-scoped, limited query each, once ready ----
  { id: "recentOrders", section: "lists", kind: "list", label: "Recent orders", source: "list", ready: false, permission: "orders.view", modules: ["orders"], query: { collection: "orders", orderBy: ["createdAt", "desc"], limit: 5 }, empty: "Orders entered in Luna will appear here." },
  { id: "lowStockItems", section: "lists", kind: "list", label: "Low-stock products", source: "list", ready: true, permission: "inventory.view", modules: ["inventory"], query: { collection: "products", where: ["isLowStock", "==", true], limit: 5 }, empty: "Products at or below their reorder level will appear here." },
  { id: "recentActivity", section: "lists", kind: "list", label: "Recent activity", source: "list", ready: false, permission: "dashboard.view", modules: [], query: null, empty: "Staff actions and alerts will appear here." },
]);

export const DASHBOARD_SECTIONS = Object.freeze([
  { id: "financial", label: "Sales and profit" },
  { id: "operations", label: "Operations" },
  { id: "lists", label: null },
]);

export function resolveDashboard({ entitlements, permissions }) {
  const modules = (entitlements && entitlements.modules) || {};
  return DASHBOARD_WIDGETS.filter(
    (w) => Boolean(permissions) && permissions[w.permission] === true && w.modules.every((id) => modules[id] === true)
  );
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
