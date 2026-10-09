// Record-list exports (Phase 12.5): Orders, Payments, Products, Inventory,
// Customers, Expenses. Each reads with its list's own query spec (so the
// file matches the filtered screen, all pages) and declares its columns.
// Columns with `needs` are only built — and their source documents only
// READ — for callers holding those permissions.

import { tableSheet, visibleColumns } from "../../../../shared/exports.js";
import { ordersQuery, paymentsQuery, productsQuery, customersQuery, expensesQuery } from "../../../../shared/list-queries.js";
import { FULFILLMENT_STATUSES, ORDER_SOURCES } from "../../../../shared/orders.js";
import { ORDER_PAYMENT_STATUSES, PAYMENT_STATES, PAYMENT_METHODS } from "../../../../shared/payments.js";
import { EXPENSE_METHODS, expenseCategoryLabel } from "../../../../shared/expenses.js";
import { CUSTOMER_STATUSES } from "../../../../shared/customers.js";
import { UNITS, COST_SCALE, inventoryValue } from "../../../../shared/quantity.js";

const label = (map, key) => map[key]?.label ?? key ?? "";
const unitLabel = (u) => UNITS[u]?.label ?? u ?? "";
const FIN = ["dashboard.financials"];
const COSTS = ["inventory.costs"];
const titleCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

// ---------- Orders ----------

const ORDER_COLUMNS = [
  { header: "Order #", format: "text", width: 14, value: (o) => o.orderNumber },
  { header: "Order date", format: "date", width: 12, value: (o) => o.orderDate },
  { header: "Created", format: "datetime", width: 17, value: (o) => o.createdAt },
  { header: "Customer", format: "text", width: 26, value: (o) => o.customer?.name },
  { header: "Phone", format: "text", width: 15, value: (o) => o.customer?.phone },
  { header: "Items", format: "text", width: 40, value: (o) => (o.items || []).map((l) => `${l.sku} × ${l.quantity / 1000} ${unitLabel(l.unit)}`).join("; ") },
  { header: "Lines", format: "integer", width: 7, value: (o) => o.itemCount },
  { header: "Subtotal", format: "money", width: 13, value: (o) => o.subtotal },
  { header: "Discount", format: "money", width: 12, value: (o) => o.discount },
  { header: "Total", format: "money", width: 13, value: (o) => o.total },
  { header: "Amount paid", format: "money", width: 13, value: (o) => o.amountPaid },
  { header: "Balance", format: "money", width: 13, value: (o) => o.balance },
  { header: "Payment", format: "text", width: 15, value: (o) => label(ORDER_PAYMENT_STATUSES, o.paymentStatus) },
  { header: "Fulfillment", format: "text", width: 16, value: (o) => label(FULFILLMENT_STATUSES, o.fulfillmentStatus) },
  { header: "Source", format: "text", width: 12, value: (o) => label(ORDER_SOURCES, o.source) },
  { header: "Last payment ref", format: "text", width: 18, value: (o) => o.lastPaymentRef },
  { header: "COGS", format: "money", width: 13, needs: FIN, value: (o) => o._costs?.cogs },
  { header: "Gross profit", format: "money", width: 13, needs: FIN, value: (o) => o._costs?.grossProfit },
];
const LINE_COLUMNS = [
  { header: "Order #", format: "text", width: 14, value: (l) => l.order.orderNumber },
  { header: "Order date", format: "date", width: 12, value: (l) => l.order.orderDate },
  { header: "Customer", format: "text", width: 26, value: (l) => l.order.customer?.name },
  { header: "SKU", format: "text", width: 14, value: (l) => l.sku },
  { header: "Product", format: "text", width: 30, value: (l) => l.name },
  { header: "Quantity", format: "quantity", width: 10, value: (l) => l.quantity },
  { header: "Unit", format: "text", width: 8, value: (l) => unitLabel(l.unit) },
  { header: "Unit price", format: "money", width: 12, value: (l) => l.unitPrice },
  { header: "Line subtotal", format: "money", width: 14, value: (l) => l.lineSubtotal },
  { header: "Line COGS", format: "money", width: 13, needs: FIN, value: (l) => l._cost },
];

async function orders({ filters, permissions, timezone, readRows, readByIds }) {
  const rows = await readRows("orders", ordersQuery(filters));
  // Costs exist only for fulfilled orders; read them only for callers who may see them.
  if (permissions["dashboard.financials"] === true) {
    const costs = await readByIds("orderCosts", rows.filter((o) => o.fulfillmentStatus === "fulfilled").map((o) => o.id));
    for (const o of rows) o._costs = costs.get(o.id) ?? null;
  }
  const lines = rows.flatMap((o) => {
    const cost = new Map((o._costs?.lines || []).map((l) => [l.lineId, l.costConsumed]));
    return (o.items || []).map((l) => ({ ...l, order: o, _cost: o._costs ? cost.get(l.lineId) ?? null : null }));
  });
  return {
    rowCount: rows.length,
    sheets: [
      tableSheet({ name: "Orders", columns: visibleColumns(ORDER_COLUMNS, permissions), rows, timezone }),
      tableSheet({ name: "Order lines", columns: visibleColumns(LINE_COLUMNS, permissions), rows: lines, timezone }),
    ],
  };
}

// ---------- Payments ----------

const PAYMENT_COLUMNS = [
  { header: "Received", format: "datetime", width: 17, value: (p) => p.receivedAt },
  { header: "Received date", format: "date", width: 12, value: (p) => p.receivedDay },
  { header: "Order #", format: "text", width: 14, value: (p) => p.orderNumber },
  { header: "Customer", format: "text", width: 26, value: (p) => p.customerName },
  { header: "Amount", format: "money", width: 13, value: (p) => p.amount },
  { header: "Method", format: "text", width: 14, value: (p) => label(PAYMENT_METHODS, p.method) },
  { header: "Reference", format: "text", width: 18, value: (p) => p.reference },
  { header: "Status", format: "text", width: 16, value: (p) => label(PAYMENT_STATES, p.state) },
  // Never the storage path or a URL: only whether a screenshot exists.
  { header: "Proof attached", format: "bool", width: 10, value: (p) => Boolean(p.proof) },
  { header: "Verified by", format: "text", width: 18, value: (p) => p.verifiedBy?.name },
  { header: "Note", format: "text", width: 30, value: (p) => p.note },
];

async function payments({ filters, permissions, timezone, readRows }) {
  const rows = await readRows("payments", paymentsQuery(filters));
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Payments", columns: visibleColumns(PAYMENT_COLUMNS, permissions), rows, timezone })] };
}

// ---------- Products / Inventory ----------

const PRODUCT_COLUMNS = [
  { header: "SKU", format: "text", width: 14, value: (p) => p.sku },
  { header: "Product", format: "text", width: 30, value: (p) => p.name },
  { header: "Category", format: "text", width: 16, value: (p) => p.category },
  { header: "Unit", format: "text", width: 8, value: (p) => unitLabel(p.unit) },
  { header: "Selling price", format: "money", width: 13, value: (p) => p.sellingPrice },
  { header: "Reorder level", format: "quantity", width: 12, value: (p) => p.reorderLevel },
  { header: "Status", format: "text", width: 10, value: (p) => titleCase(p.status) },
];
const INVENTORY_COLUMNS = [
  { header: "SKU", format: "text", width: 14, value: (p) => p.sku },
  { header: "Product", format: "text", width: 30, value: (p) => p.name },
  { header: "Category", format: "text", width: 16, value: (p) => p.category },
  { header: "Unit", format: "text", width: 8, value: (p) => unitLabel(p.unit) },
  { header: "On hand", format: "quantity", width: 10, value: (p) => p.onHand },
  { header: "Reserved", format: "quantity", width: 10, value: (p) => p.reserved },
  { header: "Available", format: "quantity", width: 10, value: (p) => p.available },
  { header: "Reorder level", format: "quantity", width: 12, value: (p) => p.reorderLevel },
  { header: "Low stock", format: "bool", width: 9, value: (p) => p.isLowStock === true },
  { header: "Selling price", format: "money", width: 13, value: (p) => p.sellingPrice },
  { header: "Status", format: "text", width: 10, value: (p) => titleCase(p.status) },
  // Average cost per unit, in pesos (costUnits / COST_SCALE centavos).
  { header: "Average cost", format: "money", width: 13, needs: COSTS, value: (p) => (Number.isSafeInteger(p._costs?.avgCostUnits) ? Math.round(p._costs.avgCostUnits / COST_SCALE) : null) },
  { header: "Inventory value (est.)", format: "money", width: 16, needs: COSTS, value: (p) => (Number.isSafeInteger(p._costs?.avgCostUnits) ? inventoryValue(p.onHand, p._costs.avgCostUnits) : null) },
];

async function products({ filters, permissions, timezone, readRows }) {
  const rows = await readRows("products", productsQuery(filters));
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Products", columns: visibleColumns(PRODUCT_COLUMNS, permissions), rows, timezone })] };
}

async function inventory({ filters, permissions, timezone, readRows, readByIds }) {
  const rows = await readRows("products", productsQuery(filters));
  if (permissions["inventory.costs"] === true) {
    const costs = await readByIds("productCosts", rows.map((p) => p.id));
    for (const p of rows) p._costs = costs.get(p.id) ?? null;
  }
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Inventory", columns: visibleColumns(INVENTORY_COLUMNS, permissions), rows, timezone })], note: "Stock levels are as of the time of export." };
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
  { header: "Total ordered", format: "money", width: 14, value: (c) => c.stats?.totalOrdered ?? 0 },
  { header: "Outstanding balance", format: "money", width: 16, value: (c) => c.stats?.outstandingBalance ?? 0 },
  { header: "Last order", format: "datetime", width: 17, value: (c) => c.stats?.lastOrderAt },
  { header: "Last order #", format: "text", width: 14, value: (c) => c.stats?.lastOrderNumber },
  { header: "Status", format: "text", width: 10, value: (c) => label(CUSTOMER_STATUSES, c.status) },
];

async function customers({ filters, permissions, timezone, readRows }) {
  const rows = await readRows("customers", customersQuery(filters));
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Customers", columns: visibleColumns(CUSTOMER_COLUMNS, permissions), rows, timezone })], note: "Order counts and balances are as of the time of export." };
}

// ---------- Expenses ----------

const EXPENSE_COLUMNS = [
  { header: "Date", format: "date", width: 12, value: (e) => e.date },
  { header: "Category", format: "text", width: 18, value: (e) => expenseCategoryLabel(e.category) },
  { header: "Vendor / payee", format: "text", width: 26, value: (e) => e.payee },
  { header: "Method", format: "text", width: 14, value: (e) => label(EXPENSE_METHODS, e.method) },
  { header: "Reference", format: "text", width: 18, value: (e) => e.reference },
  { header: "Amount", format: "money", width: 13, value: (e) => e.amount },
  { header: "Recurring", format: "bool", width: 10, value: (e) => e.recurring === true },
  { header: "Notes", format: "text", width: 30, value: (e) => e.notes },
  { header: "Status", format: "text", width: 10, value: (e) => titleCase(e.status) },
];

async function expenses({ filters, permissions, timezone, readRows }) {
  // Active only (the descriptor allows no other status).
  const rows = await readRows("expenses", expensesQuery({ ...filters, status: "active" }));
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Expenses", columns: visibleColumns(EXPENSE_COLUMNS, permissions), rows, timezone })] };
}

export const RECORD_BUILDERS = Object.freeze({ orders, payments, products, inventory, customers, expenses });
export const RECORD_COLUMNS = Object.freeze({ orders: ORDER_COLUMNS, payments: PAYMENT_COLUMNS, products: PRODUCT_COLUMNS, inventory: INVENTORY_COLUMNS, customers: CUSTOMER_COLUMNS, expenses: EXPENSE_COLUMNS });
