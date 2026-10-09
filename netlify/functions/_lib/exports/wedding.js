// Phase 16 Bridal / Wedding workbooks, through the Export Core (runExport):
// the same list specs as the screens (shared/list-queries.js), every
// matching row, refused past the row limit. Wedding columns only: no sales,
// COGS, profit, Distributor or Baby field ever appears.
//
// Category names: a record keeps the name it was saved with
// (categoryName); the workbook shows the category's CURRENT name, falling
// back to that snapshot. Supplier names on expenses / payments stay the
// snapshot, so history reads as it was paid.

import { pairsSheet, tableSheet } from "../../../../shared/exports.js";
import { expensesQuery, categoriesQuery, weddingSuppliersQuery, supplierPaymentsQuery, weddingTasksQuery, guestsQuery } from "../../../../shared/list-queries.js";
import { EXPENSE_METHODS } from "../../../../shared/expenses.js";
import { BUDGET_DOC_ID, CATEGORY_STATUSES, budgetLines, sortCategories } from "../../../../shared/baby.js";
import { SUPPLIER_SERVICES, SUPPLIER_STATUSES, SUPPLIER_PAYMENT_STATUSES, TASK_STATUSES, TASK_PRIORITIES, RSVP_STATUSES, GUEST_SIDES, supplierBalance, taskTiming, weddingSummary } from "../../../../shared/wedding.js";

const label = (map, key) => map[key]?.label ?? key ?? "";
const TIMING = { overdue: "Overdue", due_soon: "Due soon" };

async function categoryNames(readRows) {
  const rows = await readRows("expenseCategories", categoriesQuery());
  return { rows: sortCategories(rows), name: new Map(rows.map((c) => [c.id, c.name])) };
}
const categoryOf = (names) => (r) => names.get(r.category) ?? r.categoryName ?? "";

export const WEDDING_BUDGET_COLUMNS = [
  { header: "Category", format: "text", width: 24, value: (l) => l.name },
  { header: "Status", format: "text", width: 10, value: (l) => label(CATEGORY_STATUSES, l.status) },
  { header: "Budget", format: "money", width: 14, value: (l) => l.budget },
  { header: "Spent", format: "money", width: 14, value: (l) => l.spent },
  { header: "Remaining", format: "money", width: 14, value: (l) => l.remaining },
  { header: "% used", format: "percent", width: 9, value: (l) => (l.percentUsed === null ? null : l.percentUsed / 100) },
  { header: "Upcoming", format: "money", width: 14, value: (l) => l.upcoming },
];

export const weddingExpenseColumns = (names) => [
  { header: "Date", format: "date", width: 12, value: (e) => e.date },
  { header: "Category", format: "text", width: 20, value: categoryOf(names) },
  { header: "Supplier / payee", format: "text", width: 24, value: (e) => e.payee },
  { header: "Amount", format: "money", width: 13, value: (e) => e.amount },
  { header: "Method", format: "text", width: 14, value: (e) => label(EXPENSE_METHODS, e.method) },
  { header: "Reference", format: "text", width: 16, value: (e) => e.reference },
  { header: "From a supplier payment", format: "bool", width: 12, value: (e) => Boolean(e.supplierPaymentId) },
  { header: "Notes", format: "text", width: 30, value: (e) => e.notes },
];

export const SUPPLIER_COLUMNS = [
  { header: "Supplier", format: "text", width: 26, value: (s) => s.name },
  { header: "Service", format: "text", width: 18, value: (s) => label(SUPPLIER_SERVICES, s.service) },
  { header: "Agreed", format: "money", width: 13, value: (s) => s.agreedAmount },
  { header: "Paid", format: "money", width: 13, value: (s) => s.paid ?? 0 },
  { header: "Balance", format: "money", width: 13, value: (s) => supplierBalance(s) },
  { header: "Upcoming", format: "money", width: 13, value: (s) => s.upcoming ?? 0 },
  { header: "Next due", format: "date", width: 12, value: (s) => s.nextDue },
  { header: "Contact person", format: "text", width: 18, value: (s) => s.contactPerson },
  { header: "Phone", format: "text", width: 16, value: (s) => s.phone },
  { header: "Email", format: "text", width: 22, value: (s) => s.email },
  { header: "Address / location", format: "text", width: 26, value: (s) => s.location },
  { header: "Status", format: "text", width: 10, value: (s) => label(SUPPLIER_STATUSES, s.status) },
  { header: "Notes", format: "text", width: 30, value: (s) => s.notes },
];

export const paymentColumns = (names) => [
  { header: "Due date", format: "date", width: 12, value: (p) => p.dueDate },
  { header: "Supplier", format: "text", width: 24, value: (p) => p.supplierName },
  { header: "Description", format: "text", width: 26, value: (p) => p.description },
  { header: "Category", format: "text", width: 20, value: categoryOf(names) },
  { header: "Amount", format: "money", width: 13, value: (p) => p.amount },
  { header: "Status", format: "text", width: 11, value: (p) => label(SUPPLIER_PAYMENT_STATUSES, p.status) },
  { header: "Paid date", format: "date", width: 12, value: (p) => p.paidDate },
  { header: "Paid amount", format: "money", width: 13, value: (p) => p.paidAmount },
  { header: "Method", format: "text", width: 14, value: (p) => (p.method ? label(EXPENSE_METHODS, p.method) : "") },
  { header: "Reference", format: "text", width: 16, value: (p) => p.reference },
  { header: "Notes", format: "text", width: 30, value: (p) => p.notes },
];

export const taskColumns = (today) => [
  { header: "Task", format: "text", width: 34, value: (t) => t.title },
  { header: "Category", format: "text", width: 18, value: (t) => t.category },
  { header: "Assigned to", format: "text", width: 18, value: (t) => t.assignee },
  { header: "Due date", format: "date", width: 12, value: (t) => t.dueDate },
  { header: "Priority", format: "text", width: 10, value: (t) => label(TASK_PRIORITIES, t.priority) },
  { header: "Status", format: "text", width: 13, value: (t) => label(TASK_STATUSES, t.status) },
  { header: "Timing", format: "text", width: 10, value: (t) => TIMING[taskTiming(t, today)] ?? "" },
  { header: "Completed", format: "date", width: 12, value: (t) => t.completedDate },
  { header: "Notes", format: "text", width: 30, value: (t) => t.notes },
];

export const GUEST_COLUMNS = [
  { header: "Guest", format: "text", width: 26, value: (g) => g.name },
  { header: "Group", format: "text", width: 18, value: (g) => g.group },
  { header: "Side", format: "text", width: 14, value: (g) => label(GUEST_SIDES, g.side) },
  { header: "Party size", format: "integer", width: 10, value: (g) => g.partySize },
  { header: "RSVP", format: "text", width: 14, value: (g) => label(RSVP_STATUSES, g.rsvp) },
  { header: "Confirmed guests", format: "integer", width: 10, value: (g) => g.confirmed ?? 0 },
  { header: "Invitation sent", format: "date", width: 12, value: (g) => g.invitationSent },
  { header: "RSVP date", format: "date", width: 12, value: (g) => g.rsvpDate },
  { header: "Contact", format: "text", width: 20, value: (g) => g.contact },
  { header: "Notes", format: "text", width: 30, value: (g) => g.notes },
];

const readBudget = async (readByIds) => (await readByIds("budgets", [BUDGET_DOC_ID])).get(BUDGET_DOC_ID) ?? null;

// The wedding budget as of now: [label, format, value, note] pairs.
export function weddingBudgetPairs(doc, now) {
  const s = weddingSummary(doc);
  const money = (l, v, note) => (v === null ? [l, "text", "No budget set", note] : [l, "money", v, note]);
  return [
    ["As of", "datetime", now, "Current figures at export time (no history is stored)"],
    money("Total wedding budget", s.total, "Set on the Wedding Budget screen"),
    ["Total spent", "money", s.spent, "All active Wedding Expenses"],
    money("Remaining budget", s.remaining, "Total budget − total spent"),
    ["Upcoming payments", "money", s.upcoming, `${s.upcomingCount} scheduled supplier payment(s), not counted as spent`],
    ["Supplier balance", "money", s.supplierBalance, "Agreed amounts − paid, for suppliers with an agreement"],
  ];
}

async function weddingBudget({ filters, timezone, now, readRows, readByIds }) {
  const [doc, cats] = await Promise.all([readBudget(readByIds), categoryNames(readRows)]);
  const lines = budgetLines(doc, cats.rows).filter((l) => (!filters.category || l.id === filters.category) && (!filters.status || l.status === filters.status));
  return { rowCount: lines.length, sheets: [pairsSheet({ name: "Wedding Budget", timezone, rows: weddingBudgetPairs(doc, now) }), tableSheet({ name: "Category Budget", columns: WEDDING_BUDGET_COLUMNS, rows: lines, timezone })], note: "Spent, Remaining and the supplier balance are computed by Luna, as of export time." };
}

async function weddingExpenses({ filters, timezone, readRows }) {
  const [rows, cats] = await Promise.all([readRows("expenses", expensesQuery({ ...filters, status: "active" })), categoryNames(readRows)]);
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Wedding Expenses", columns: weddingExpenseColumns(cats.name), rows, timezone })] };
}

async function weddingSuppliers({ filters, timezone, readRows }) {
  const rows = await readRows("weddingSuppliers", weddingSuppliersQuery(filters));
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Wedding Suppliers", columns: SUPPLIER_COLUMNS, rows, timezone })], note: "Paid = the supplier's active Wedding Expenses. Balance = agreed − paid (only with an agreement)." };
}

async function supplierPayments({ filters, timezone, readRows }) {
  const [rows, cats] = await Promise.all([readRows("supplierPayments", supplierPaymentsQuery(filters)), categoryNames(readRows)]);
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Supplier Payments", columns: paymentColumns(cats.name), rows, timezone })], note: "Upcoming payments are commitments, not spending: they count as spent only once marked Paid." };
}

async function weddingTasks({ filters, timezone, today, readRows }) {
  const rows = await readRows("weddingTasks", weddingTasksQuery(filters, { today }));
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Wedding Tasks", columns: taskColumns(today), rows, timezone })], note: `Overdue / due soon are worked out against the business's today (${today}); they are never stored.` };
}

async function guests({ filters, timezone, readRows }) {
  const rows = await readRows("guests", guestsQuery(filters));
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Guests & RSVP", columns: GUEST_COLUMNS, rows, timezone })], note: "Party size = invited people; Confirmed guests = people who said they're attending." };
}

// The Wedding Dashboard workbook's extra sheets (summaries.js), each only
// with its view permission. Never a Distributor or Baby sheet.
export async function weddingDashboardSheets({ filters, permissions, timezone, today, readRows, readByIds }) {
  const can = (p) => permissions[p] === true;
  const sheets = [];
  let rowCount = 0;
  const cats = can("budget.view") || can("expenses.view") || can("vendorpayments.view") ? await categoryNames(readRows) : { rows: [], name: new Map() };
  const table = (name, columns, rows) => {
    rowCount += rows.length;
    sheets.push(tableSheet({ name, columns, rows, timezone }));
  };
  if (can("budget.view")) table("Category Budget", WEDDING_BUDGET_COLUMNS, budgetLines(await readBudget(readByIds), cats.rows));
  if (can("expenses.view")) table("Expenses", weddingExpenseColumns(cats.name), await readRows("expenses", expensesQuery({ status: "active", from: filters.from, to: filters.to })));
  if (can("vendors.view")) table("Supplier Balances", SUPPLIER_COLUMNS, await readRows("weddingSuppliers", weddingSuppliersQuery({ status: "active" })));
  if (can("vendorpayments.view")) table("Upcoming Payments", paymentColumns(cats.name), await readRows("supplierPayments", supplierPaymentsQuery({ status: "upcoming" })));
  if (can("tasks.view")) table("Tasks", taskColumns(today), await readRows("weddingTasks", weddingTasksQuery({ state: "open" })));
  if (can("guests.view")) table("Guests & RSVP", GUEST_COLUMNS, await readRows("guests", guestsQuery({})));
  return { sheets, rowCount };
}

export const WEDDING_BUILDERS = Object.freeze({ weddingBudget, weddingExpenses, weddingSuppliers, supplierPayments, weddingTasks, guests });
