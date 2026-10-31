// Luna Business: the Download Excel sheets (shared/workbook.js).
//   Orders     one row per order in the range; items as readable text
//              ("Hayst Kopi × 2; Hayst Choco × 1"), never an item array
//   Payments   payments received in the range (voided ones left out)
//   Users      name, email (or login ID), role, status; never a Firebase UID
//   Inventory  the active products as the Inventory screen shows them
//   Operating Expenses  the Costs page's expenses in the range
//   COGS       each active product's current unit cost (inventory.costs)
//   Customers  the active saved customers: name, contact, delivery address
//              and Luna's own order count (back 2026-10-20; no ids)
// Each sheet only with its module and view permission (COGS also needs
// inventory.costs). No averages, stock value or profit: unit costs only.
// Reseller Package (2026-10-31; Resellers module + resellers.view): Orders
// gain Reseller, the prices (selling / owner), Owner Amount, Calculated and
// Final Commission, Commission Paid / Remaining / Status (payouts settle the
// oldest commission first); plus Resellers and Commission Payouts sheets.
// A Distributor workbook is unchanged.

import { ordersQuery, paymentsQuery, productsQuery, expensesQuery, customersQuery } from "../../../../shared/list-queries.js";
import { expenseCategoryLabel } from "../../../../shared/expenses.js";
import { costUnitsToCentavos } from "../../../../shared/quantity.js";
import { ORDER_SOURCES, FULFILLMENT_STATUSES } from "../../../../shared/orders.js";
import { ORDER_PAYMENT_STATUSES, PAYMENT_METHODS } from "../../../../shared/payments.js";
import { UNITS, formatQuantity } from "../../../../shared/quantity.js";
import { ROLE_TEMPLATES } from "../../../../shared/permissions.js";
import { loginName } from "../activation.js";
import { byText } from "./common.js";
import { allocatePayouts, earnedOf, ownerAmountOf, commissionSummary, COMMISSION_STATUSES, PAYOUT_METHODS } from "../../../../shared/resellers.js";

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
  { header: "Sent by", format: "text", width: 22, value: (p) => (p.via === "payment_link" ? "Customer (payment link)" : p.createdBy?.name) },
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
const CUSTOMER_COLUMNS = [
  { header: "Customer", format: "text", width: 28, value: (c) => c.name },
  { header: "Contact", format: "text", width: 20, value: (c) => c.phone || "" },
  { header: "Delivery Address", format: "text", width: 40, value: (c) => c.address || "" },
  { header: "Total Orders", format: "integer", width: 12, total: true, value: (c) => c.stats?.orderCount ?? 0 },
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

// Reseller Package columns on Orders. Per-order payout state needs every
// reseller order (oldest first), not only the range.
const peso = (c) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const priceText = (items) => (Array.isArray(items) ? items.map((l) => `${l.name} @ ${peso(l.unitPrice)}${Number.isSafeInteger(l.basePrice) ? ` (owner ${peso(l.basePrice)})` : ""}`).join("; ") : "");
async function resellerOrderColumns(x, resellers) {
  const lists = await Promise.all(resellers.map((r) => x.tenant.collection("orders").where("resellerId", "==", r.id).limit(5000).get()));
  const all = lists.flatMap((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  const paidOf = new Map(resellers.map((r) => [r.id, r.paid || 0]));
  const alloc = new Map();
  for (const id of new Set(all.map((o) => o.resellerId))) {
    for (const [orderId, v] of allocatePayouts(all.filter((o) => o.resellerId === id).map((o) => ({ id: o.id, date: o.orderDate, final: earnedOf(o) })), paidOf.get(id) || 0)) alloc.set(orderId, v);
  }
  const of = (o) => (o.resellerId ? alloc.get(o.id) ?? null : null);
  return [
    { header: "Reseller", format: "text", width: 18, value: (o) => o.reseller?.name ?? "Direct sale" },
    { header: "Selling / Owner Price", format: "text", width: 40, value: (o) => (o.resellerId ? priceText(o.items) : "") },
    { header: "Owner Amount", format: "money", width: 14, total: true, value: (o) => (o.resellerId ? ownerAmountOf(o.items) : o.total) },
    { header: "Calculated Commission", format: "money", width: 14, total: true, value: (o) => (o.resellerId ? o.commission?.calculated ?? 0 : 0) },
    { header: "Final Commission", format: "money", width: 14, total: true, value: (o) => earnedOf(o) },
    { header: "Commission Paid", format: "money", width: 14, total: true, value: (o) => of(o)?.paid ?? 0 },
    { header: "Commission Remaining", format: "money", width: 14, total: true, value: (o) => of(o)?.remaining ?? 0 },
    { header: "Commission Status", format: "text", width: 16, value: (o) => (o.resellerId ? COMMISSION_STATUSES[of(o)?.status ?? "none"]?.label ?? "" : "") },
  ];
}
const RESELLER_COLUMNS = [
  { header: "Reseller", format: "text", width: 22, value: (r) => r.name },
  { header: "Status", format: "text", width: 10, value: (r) => (r.status === "active" ? "Active" : "Inactive") },
  { header: "Commission Earned", format: "money", width: 16, total: true, value: (r) => r.earned || 0 },
  { header: "Commission Paid", format: "money", width: 16, total: true, value: (r) => r.paid || 0 },
  { header: "Commission Remaining", format: "money", width: 16, total: true, value: (r) => commissionSummary(r.earned, r.paid).remaining },
  { header: "Commission Status", format: "text", width: 16, value: (r) => COMMISSION_STATUSES[commissionSummary(r.earned, r.paid).status]?.label ?? "" },
];
const PAYOUT_COLUMNS = [
  { header: "Date", format: "date", width: 14, value: (p) => p.date },
  { header: "Reseller", format: "text", width: 22, value: (p) => p.resellerName },
  { header: "Amount", format: "money", width: 14, total: true, value: (p) => (p.state === "reversed" ? 0 : p.amount) },
  { header: "Method", format: "text", width: 14, value: (p) => (p.method ? PAYOUT_METHODS[p.method]?.label ?? p.method : "") },
  { header: "Reference", format: "text", width: 18, value: (p) => p.reference || "" },
  { header: "Notes", format: "text", width: 28, value: (p) => [p.notes, p.state === "reversed" ? `Reversed: ${p.reversal?.reason ?? ""}` : ""].filter(Boolean).join(" · ") },
];

export async function businessSheets(x) {
  const { from, to } = x.range;
  const dated = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const sheets = [];
  const resellers = x.can("resellers", "resellers.view") ? await x.readAll("resellers") : null;
  if (x.can("orders", "orders.view")) {
    const rows = await x.readRows("orders", ordersQuery(dated));
    rows.sort((a, b) => (a.orderDate < b.orderDate ? -1 : a.orderDate > b.orderDate ? 1 : byText(a.orderNumber, b.orderNumber)));
    sheets.push({ name: "Orders", columns: resellers ? [...ORDER_COLUMNS, ...(await resellerOrderColumns(x, resellers))] : ORDER_COLUMNS, rows });
  }
  if (resellers) {
    sheets.push({ name: "Resellers", columns: RESELLER_COLUMNS, rows: [...resellers].sort((a, b) => byText(a.name, b.name)) });
    const payouts = (await x.readAll("commissionPayouts")).filter((p) => (!from || p.date >= from) && (!to || p.date <= to)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byText(a.resellerName, b.resellerName)));
    sheets.push({ name: "Commission Payouts", columns: PAYOUT_COLUMNS, rows: payouts });
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
  if (x.can("customers", "customers.view")) sheets.push({ name: "Customers", columns: CUSTOMER_COLUMNS, rows: await x.readRows("customers", customersQuery({ status: "active" })) });
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
