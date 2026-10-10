// Record-list exports (Phase 12.5): Orders, Payments, Products, Inventory,
// Customers, Expenses. Each reads with its list's own query spec (so the
// file matches the filtered screen, all pages) and declares its columns.
// Columns with `needs` are only built — and their source documents only
// READ — for callers holding those permissions.
// Phase 18.6: each returns ONE table (one worksheet). `total: true` marks
// columns whose total row means something. Orders: one row per order
// (Record "Order") followed by its lines (Record "Line"); order money and
// line money live in different columns, so no total counts twice.

import { visibleColumns } from "../../../../shared/exports.js";
import { ordersQuery, paymentsQuery, productsQuery, customersQuery, expensesQuery } from "../../../../shared/list-queries.js";
import { FULFILLMENT_STATUSES, ORDER_SOURCES } from "../../../../shared/orders.js";
import { ORDER_PAYMENT_STATUSES, PAYMENT_STATES, PAYMENT_METHODS } from "../../../../shared/payments.js";
import { EXPENSE_METHODS, expenseCategoryLabel } from "../../../../shared/expenses.js";
import { CUSTOMER_STATUSES } from "../../../../shared/customers.js";
import { UNITS, COST_SCALE, inventoryValue, costUnitsToCentavos } from "../../../../shared/quantity.js";

const label = (map, key) => map[key]?.label ?? key ?? "";
const unitLabel = (u) => UNITS[u]?.label ?? u ?? "";
const FIN = ["dashboard.financials"];
const COSTS = ["inventory.costs"];
const titleCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

// ---------- Orders ----------

const isOrder = (r) => r.record === "Order";
const ORDER_COLUMNS = [
  { header: "Record", format: "text", width: 8, value: (r) => r.record },
  { header: "Order #", format: "text", width: 14, value: (r) => r.order.orderNumber },
  { header: "Order date", format: "date", width: 12, value: (r) => r.order.orderDate },
  { header: "Created", format: "datetime", width: 17, value: (r) => (isOrder(r) ? r.order.createdAt : null) },
  { header: "Customer", format: "text", width: 26, value: (r) => r.order.customer?.name },
  { header: "Phone", format: "text", width: 15, value: (r) => (isOrder(r) ? r.order.customer?.phone : null) },
  { header: "Came from", format: "text", width: 12, value: (r) => (isOrder(r) ? label(ORDER_SOURCES, r.order.source) : null) },
  { header: "Source note", format: "text", width: 22, value: (r) => (isOrder(r) ? r.order.sourceNote : null) },
  { header: "Delivery address", format: "text", width: 30, value: (r) => (isOrder(r) ? r.order.deliveryAddress : null) },
  { header: "SKU", format: "text", width: 14, value: (r) => r.line?.sku },
  { header: "Product", format: "text", width: 28, value: (r) => (isOrder(r) ? `${r.order.itemCount ?? (r.order.items || []).length} item(s)` : r.line.name) },
  { header: "Quantity", format: "quantity", width: 10, value: (r) => r.line?.quantity },
  { header: "Unit", format: "text", width: 8, value: (r) => (r.line ? unitLabel(r.line.unit) : null) },
  { header: "Unit price", format: "money", width: 12, value: (r) => r.line?.unitPrice },
  { header: "Line amount", format: "money", width: 13, total: true, value: (r) => r.line?.lineSubtotal },
  { header: "Line cost (COGS)", format: "money", width: 14, needs: FIN, total: true, value: (r) => (r.line ? r._cost : null) },
  { header: "Order subtotal", format: "money", width: 13, value: (r) => (isOrder(r) ? r.order.subtotal : null) },
  { header: "Discount", format: "money", width: 12, total: true, value: (r) => (isOrder(r) ? r.order.discount : null) },
  { header: "Order total", format: "money", width: 13, total: true, value: (r) => (isOrder(r) ? r.order.total : null) },
  { header: "Amount paid", format: "money", width: 13, total: true, value: (r) => (isOrder(r) ? r.order.amountPaid : null) },
  { header: "Balance", format: "money", width: 13, total: true, value: (r) => (isOrder(r) ? r.order.balance : null) },
  { header: "Payment", format: "text", width: 15, value: (r) => (isOrder(r) ? label(ORDER_PAYMENT_STATUSES, r.order.paymentStatus) : null) },
  { header: "Fulfillment", format: "text", width: 16, value: (r) => (isOrder(r) ? label(FULFILLMENT_STATUSES, r.order.fulfillmentStatus) : null) },
  { header: "Last payment ref", format: "text", width: 18, value: (r) => (isOrder(r) ? r.order.lastPaymentRef : null) },
  { header: "Gross profit", format: "money", width: 13, needs: FIN, total: true, value: (r) => (isOrder(r) ? r.order._costs?.grossProfit : null) },
  { header: "Notes", format: "text", width: 30, value: (r) => (isOrder(r) ? r.order.notes : null) },
];

async function orders({ filters, permissions, readRows, readByIds }) {
  const rows = await readRows("orders", ordersQuery(filters));
  // Costs exist only for fulfilled orders; read them only for callers who may see them.
  if (permissions["dashboard.financials"] === true) {
    const costs = await readByIds("orderCosts", rows.filter((o) => o.fulfillmentStatus === "fulfilled").map((o) => o.id));
    for (const o of rows) o._costs = costs.get(o.id) ?? null;
  }
  const out = rows.flatMap((o) => {
    const cost = new Map((o._costs?.lines || []).map((l) => [l.lineId, l.costConsumed]));
    return [{ record: "Order", order: o }, ...(o.items || []).map((l) => ({ record: "Line", order: o, line: l, _cost: o._costs ? cost.get(l.lineId) ?? null : null }))];
  });
  return { rowCount: rows.length, table: { name: "Orders", columns: visibleColumns(ORDER_COLUMNS, permissions), rows: out } };
}

// ---------- Payments ----------

const PAYMENT_COLUMNS = [
  { header: "Received", format: "datetime", width: 17, value: (p) => p.receivedAt },
  { header: "Received date", format: "date", width: 12, value: (p) => p.receivedDay },
  { header: "Order #", format: "text", width: 14, value: (p) => p.orderNumber },
  { header: "Customer", format: "text", width: 26, value: (p) => p.customerName },
  { header: "Amount", format: "money", width: 13, total: true, value: (p) => p.amount },
  { header: "Method", format: "text", width: 14, value: (p) => label(PAYMENT_METHODS, p.method) },
  { header: "Reference", format: "text", width: 18, value: (p) => p.reference },
  { header: "Status", format: "text", width: 16, value: (p) => label(PAYMENT_STATES, p.state) },
  // Never the storage path or a URL: only whether a screenshot exists.
  { header: "Proof attached", format: "bool", width: 10, value: (p) => Boolean(p.proof) },
  { header: "Verified by", format: "text", width: 18, value: (p) => p.verifiedBy?.name },
  { header: "Note", format: "text", width: 30, value: (p) => p.note },
];

async function payments({ filters, permissions, readRows }) {
  const rows = await readRows("payments", paymentsQuery(filters));
  return { rowCount: rows.length, table: { name: "Payments", columns: visibleColumns(PAYMENT_COLUMNS, permissions), rows } };
}

// ---------- Products / Inventory ----------

const PRODUCT_COLUMNS = [
  { header: "SKU", format: "text", width: 14, value: (p) => p.sku },
  { header: "Product", format: "text", width: 30, value: (p) => p.name },
  { header: "Category", format: "text", width: 16, value: (p) => p.category },
  { header: "Unit", format: "text", width: 8, value: (p) => unitLabel(p.unit) },
  { header: "Selling price", format: "money", width: 13, value: (p) => p.sellingPrice },
  { header: "Cost price (average)", format: "money", width: 14, needs: COSTS, value: (p) => (Number.isSafeInteger(p._costs?.avgCostUnits) ? Math.round(p._costs.avgCostUnits / COST_SCALE) : null) },
  { header: "Profit per unit (est.)", format: "money", width: 14, needs: COSTS, value: (p) => (Number.isSafeInteger(p._costs?.avgCostUnits) ? p.sellingPrice - costUnitsToCentavos(p._costs.avgCostUnits) : null) },
  { header: "Reorder level", format: "quantity", width: 12, value: (p) => p.reorderLevel },
  { header: "Status", format: "text", width: 10, value: (p) => titleCase(p.status) },
];
const INVENTORY_COLUMNS = [
  { header: "SKU", format: "text", width: 14, value: (p) => p.sku },
  { header: "Product", format: "text", width: 30, value: (p) => p.name },
  { header: "Category", format: "text", width: 16, value: (p) => p.category },
  { header: "Unit", format: "text", width: 8, value: (p) => unitLabel(p.unit) },
  { header: "Stock left", format: "quantity", width: 10, value: (p) => p.available },
  { header: "In stock", format: "quantity", width: 10, value: (p) => p.onHand },
  { header: "Set aside for orders", format: "quantity", width: 12, value: (p) => p.reserved },
  { header: "Reorder level", format: "quantity", width: 12, value: (p) => p.reorderLevel },
  { header: "Low stock", format: "bool", width: 9, value: (p) => p.isLowStock === true },
  { header: "Selling price", format: "money", width: 13, value: (p) => p.sellingPrice },
  { header: "Status", format: "text", width: 10, value: (p) => titleCase(p.status) },
  // Average cost per unit, in pesos (costUnits / COST_SCALE centavos).
  { header: "Average cost", format: "money", width: 13, needs: COSTS, value: (p) => (Number.isSafeInteger(p._costs?.avgCostUnits) ? Math.round(p._costs.avgCostUnits / COST_SCALE) : null) },
  { header: "Profit per unit (est.)", format: "money", width: 14, needs: COSTS, value: (p) => (Number.isSafeInteger(p._costs?.avgCostUnits) ? p.sellingPrice - costUnitsToCentavos(p._costs.avgCostUnits) : null) },
  { header: "Stock value (est.)", format: "money", width: 16, needs: COSTS, total: true, value: (p) => (Number.isSafeInteger(p._costs?.avgCostUnits) ? inventoryValue(p.onHand, p._costs.avgCostUnits) : null) },
];

async function products({ filters, permissions, readRows, readByIds }) {
  const rows = await readRows("products", productsQuery(filters));
  // Phase 18.6: cost price and estimated profit per unit next to the selling price (inventory.costs only).
  if (permissions["inventory.costs"] === true) {
    const costs = await readByIds("productCosts", rows.map((p) => p.id));
    for (const p of rows) p._costs = costs.get(p.id) ?? null;
  }
  return { rowCount: rows.length, table: { name: "Products", columns: visibleColumns(PRODUCT_COLUMNS, permissions), rows } };
}

async function inventory({ filters, permissions, readRows, readByIds }) {
  const rows = await readRows("products", productsQuery(filters));
  if (permissions["inventory.costs"] === true) {
    const costs = await readByIds("productCosts", rows.map((p) => p.id));
    for (const p of rows) p._costs = costs.get(p.id) ?? null;
  }
  return { rowCount: rows.length, table: { name: "Inventory", columns: visibleColumns(INVENTORY_COLUMNS, permissions), rows }, note: "Stock levels are as of the time of export. Stock left = in stock − set aside for open orders. Cost is the moving average of what you paid." };
}

// ---------- Customers ----------

// Totals are the customer record's own server-kept statistics, shown on the
// Customers page to everyone with customers.view.
const CUSTOMER_COLUMNS = [
  { header: "Customer", format: "text", width: 28, value: (c) => c.name },
  { header: "Company", format: "text", width: 22, value: (c) => c.company },
  { header: "Phone", format: "text", width: 15, value: (c) => c.phone },
  { header: "Email", format: "text", width: 24, value: (c) => c.email },
  { header: "Address", format: "text", width: 34, value: (c) => c.address },
  { header: "Orders", format: "integer", width: 8, value: (c) => c.stats?.orderCount ?? 0 },
  { header: "Total ordered", format: "money", width: 14, total: true, value: (c) => c.stats?.totalOrdered ?? 0 },
  { header: "Outstanding balance", format: "money", width: 16, total: true, value: (c) => c.stats?.outstandingBalance ?? 0 },
  { header: "Last order", format: "datetime", width: 17, value: (c) => c.stats?.lastOrderAt },
  { header: "Last order #", format: "text", width: 14, value: (c) => c.stats?.lastOrderNumber },
  { header: "Status", format: "text", width: 10, value: (c) => label(CUSTOMER_STATUSES, c.status) },
];

async function customers({ filters, permissions, readRows }) {
  const rows = await readRows("customers", customersQuery(filters));
  return { rowCount: rows.length, table: { name: "Customers", columns: visibleColumns(CUSTOMER_COLUMNS, permissions), rows }, note: "Order counts and balances are as of the time of export." };
}

// ---------- Expenses ----------

const EXPENSE_COLUMNS = [
  { header: "Date", format: "date", width: 12, value: (e) => e.date },
  { header: "Category", format: "text", width: 18, value: (e) => expenseCategoryLabel(e.category) },
  { header: "Vendor / payee", format: "text", width: 26, value: (e) => e.payee },
  { header: "Method", format: "text", width: 14, value: (e) => label(EXPENSE_METHODS, e.method) },
  { header: "Reference", format: "text", width: 18, value: (e) => e.reference },
  { header: "Amount", format: "money", width: 13, total: true, value: (e) => e.amount },
  { header: "Recurring", format: "bool", width: 10, value: (e) => e.recurring === true },
  { header: "Notes", format: "text", width: 30, value: (e) => e.notes },
  { header: "Status", format: "text", width: 10, value: (e) => titleCase(e.status) },
];

async function expenses({ filters, permissions, readRows }) {
  // Active only (the descriptor allows no other status).
  const rows = await readRows("expenses", expensesQuery({ ...filters, status: "active" }));
  return { rowCount: rows.length, table: { name: "Expenses", columns: visibleColumns(EXPENSE_COLUMNS, permissions), rows } };
}

export const RECORD_BUILDERS = Object.freeze({ orders, payments, products, inventory, customers, expenses });
export const RECORD_COLUMNS = Object.freeze({ orders: ORDER_COLUMNS, payments: PAYMENT_COLUMNS, products: PRODUCT_COLUMNS, inventory: INVENTORY_COLUMNS, customers: CUSTOMER_COLUMNS, expenses: EXPENSE_COLUMNS });
