// Luna Business: the Download Excel sheets (shared/workbook.js).
//   Orders     one row per order in the range; items as readable text
//              ("Hayst Kopi × 2; Hayst Choco × 1"), never an item array
//   Payments   payments received in the range (voided ones left out)
//   Users      name, email (or login ID), role, status; never a Firebase UID
//   Inventory  the active products as the Inventory screen shows them
//   Operating Expenses  the Costs page's expenses in the range
//   COGS       each active product's current unit cost (inventory.costs)
// Customers is hidden in Business for now (Owner pilot, 2026-10-19): no
// sheet; customer details stay on each order.
// Each sheet only with its module and view permission (COGS also needs
// inventory.costs). No averages, stock value or profit: unit costs only.

import { ordersQuery, paymentsQuery, productsQuery, expensesQuery } from "../../../../shared/list-queries.js";
import { expenseCategoryLabel } from "../../../../shared/expenses.js";
import { costUnitsToCentavos } from "../../../../shared/quantity.js";
import { ORDER_SOURCES, FULFILLMENT_STATUSES } from "../../../../shared/orders.js";
import { ORDER_PAYMENT_STATUSES, PAYMENT_METHODS } from "../../../../shared/payments.js";
import { UNITS, formatQuantity } from "../../../../shared/quantity.js";
import { ROLE_TEMPLATES } from "../../../../shared/permissions.js";
import { loginName } from "../activation.js";
import { byText } from "./common.js";

const label = (map, key) => map[key]?.label ?? key ?? "";
const unitText = (u) => (u && u !== "pcs" ? ` ${UNITS[u]?.label ?? u}` : "");
// "Hayst Kopi × 2; Beans × 1.5 kg"
export const itemsText = (items) => (Array.isArray(items) ? items.map((l) => `${l.name} × ${formatQuantity(l.quantity)}${unitText(l.unit)}`).join("; ") : "");
const sourceText = (o) => [label(ORDER_SOURCES, o.source), o.sourceNote].filter(Boolean).join(" · ");
const statusText = (o) => [label(FULFILLMENT_STATUSES, o.fulfillmentStatus), label(ORDER_PAYMENT_STATUSES, o.paymentStatus)].filter(Boolean).join(" · ");

const ORDER_COLUMNS = [
  { header: "Order No.", format: "text", width: 18, value: (o) => o.orderNumber },
  { header: "Date", format: "date", width: 14, value: (o) => o.orderDate },
  { header: "Customer", format: "text", width: 24, value: (o) => o.customer?.name },
  { header: "Source", format: "text", width: 20, value: sourceText },
  { header: "Items", format: "text", width: 40, value: (o) => itemsText(o.items) },
  { header: "Total", format: "money", width: 14, total: true, value: (o) => o.total },
  { header: "Paid", format: "money", width: 14, total: true, value: (o) => o.amountPaid ?? 0 },
  { header: "Balance", format: "money", width: 14, total: true, value: (o) => o.balance ?? 0 },
  { header: "Status", format: "text", width: 20, value: statusText },
  { header: "Created By", format: "text", width: 18, value: (o) => o.createdBy?.name },
];
const PAYMENT_COLUMNS = [
  { header: "Date", format: "date", width: 14, value: (p) => p.receivedDay },
  { header: "Order No.", format: "text", width: 18, value: (p) => p.orderNumber },
  { header: "Customer", format: "text", width: 24, value: (p) => p.customerName },
  { header: "Amount", format: "money", width: 14, total: true, value: (p) => p.amount },
  { header: "Method", format: "text", width: 14, value: (p) => label(PAYMENT_METHODS, p.method) },
  { header: "Reference", format: "text", width: 18, value: (p) => p.reference },
];
const memberStatus = (m) => (m.status !== "active" ? "Disabled" : m.activation?.status === "pending" ? "Invited" : "Active");
const USER_COLUMNS = [
  { header: "Name", format: "text", width: 24, value: (m) => m.name },
  { header: "Email", format: "text", width: 30, value: (m) => loginName(m.email || "") },
  { header: "Role", format: "text", width: 14, value: (m) => ROLE_TEMPLATES[m.roleTemplate]?.label ?? "Custom" },
  { header: "Status", format: "text", width: 10, value: memberStatus },
];
const INVENTORY_COLUMNS = [
  { header: "Product", format: "text", width: 30, value: (p) => p.name },
  { header: "Category", format: "text", width: 18, value: (p) => p.category },
  { header: "Unit", format: "text", width: 8, value: (p) => UNITS[p.unit]?.label ?? p.unit },
  { header: "Stock Left", format: "quantity", width: 11, value: (p) => p.available },
  { header: "Selling Price", format: "money", width: 14, value: (p) => p.sellingPrice },
];
const EXPENSE_COLUMNS = [
  { header: "Date", format: "date", width: 14, value: (e) => e.date },
  { header: "Expense", format: "text", width: 32, value: (e) => e.payee || expenseCategoryLabel(e.category) },
  { header: "Amount", format: "money", width: 14, total: true, value: (e) => e.amount },
];
const COGS_COLUMNS = [
  { header: "Product", format: "text", width: 30, value: (p) => p.name },
  { header: "Unit Cost", format: "money", width: 14, value: (p) => p.unitCost },
];

export async function businessSheets(x) {
  const { from, to } = x.range;
  const dated = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const sheets = [];
  if (x.can("orders", "orders.view")) {
    const rows = await x.readRows("orders", ordersQuery(dated));
    rows.sort((a, b) => (a.orderDate < b.orderDate ? -1 : a.orderDate > b.orderDate ? 1 : byText(a.orderNumber, b.orderNumber)));
    sheets.push({ name: "Orders", columns: ORDER_COLUMNS, rows });
  }
  if (x.can("payments", "payments.view")) {
    const rows = (await x.readRows("payments", paymentsQuery(dated))).filter((p) => p.state !== "voided");
    rows.sort((a, b) => (a.receivedDay < b.receivedDay ? -1 : a.receivedDay > b.receivedDay ? 1 : byText(a.orderNumber, b.orderNumber)));
    sheets.push({ name: "Payments", columns: PAYMENT_COLUMNS, rows });
  }
  if (x.can("users", "users.view")) {
    const order = { owner: 0, manager: 1, staff: 2 };
    const rows = (await x.readAll("members")).sort((a, b) => (order[a.roleTemplate] ?? 9) - (order[b.roleTemplate] ?? 9) || byText(a.name, b.name));
    sheets.push({ name: "Users", columns: USER_COLUMNS, rows });
  }
  if (x.can("inventory", "inventory.view")) sheets.push({ name: "Inventory", columns: INVENTORY_COLUMNS, rows: await x.readRows("products", productsQuery({ status: "active" })) });
  if (x.can("expenses", "expenses.view")) {
    const rows = await x.readRows("expenses", expensesQuery({ status: "active", ...dated }));
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byText(a.payee, b.payee)));
    sheets.push({ name: "Operating Expenses", columns: EXPENSE_COLUMNS, rows });
  }
  if (x.can("inventory", "inventory.view", "inventory.costs")) {
    const products = await x.readRows("products", productsQuery({ status: "active" }));
    const costs = await x.readByIds("productCosts", products.map((p) => p.id));
    const rows = products.map((p) => ({ name: p.name, avg: costs.get(p.id)?.avgCostUnits })).filter((p) => Number.isSafeInteger(p.avg)).map((p) => ({ name: p.name, unitCost: costUnitsToCentavos(p.avg) }));
    sheets.push({ name: "COGS", columns: COGS_COLUMNS, rows });
  }
  return sheets;
}
