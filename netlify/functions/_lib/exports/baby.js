// Phase 15 Baby Expense Tracker workbooks, through the Export Core
// (runExport): the same list specs as the screens (shared/list-queries.js),
// every matching row, refused past the row limit. Baby columns only: no
// sales, COGS, profit or other Distributor field ever appears.
//
// Category names: an expense / payment keeps the name it was recorded with
// (categoryName); the workbook shows the category's CURRENT name (as the
// screens do), falling back to that snapshot. Provider names stay the
// snapshot (payee), so history reads as it was paid.

import { pairsSheet, tableSheet } from "../../../../shared/exports.js";
import { expensesQuery, categoriesQuery, providersQuery, scheduledPaymentsQuery } from "../../../../shared/list-queries.js";
import { EXPENSE_METHODS } from "../../../../shared/expenses.js";
import { BUDGET_DOC_ID, CATEGORY_STATUSES, PROVIDER_TYPES, PROVIDER_STATUSES, SCHEDULE_STATUSES, budgetSummary, budgetLines, sortCategories } from "../../../../shared/baby.js";

const label = (map, key) => map[key]?.label ?? key ?? "";
const NO_BUDGET = "No budget set";

// Every category (at most MAX_CATEGORIES) -> id -> current name.
async function categoryNames(readRows) {
  const rows = await readRows("expenseCategories", categoriesQuery());
  return { rows: sortCategories(rows), name: new Map(rows.map((c) => [c.id, c.name])) };
}
const categoryOf = (names) => (r) => names.get(r.category) ?? r.categoryName ?? "";

export const CATEGORY_BUDGET_COLUMNS = [
  { header: "Category", format: "text", width: 24, value: (l) => l.name },
  { header: "Status", format: "text", width: 10, value: (l) => label(CATEGORY_STATUSES, l.status) },
  { header: "Budget", format: "money", width: 14, value: (l) => l.budget },
  { header: "Spent", format: "money", width: 14, value: (l) => l.spent },
  { header: "Remaining", format: "money", width: 14, value: (l) => l.remaining },
  { header: "% used", format: "percent", width: 9, value: (l) => (l.percentUsed === null ? null : l.percentUsed / 100) },
  { header: "Upcoming", format: "money", width: 14, value: (l) => l.upcoming },
];

export const babyExpenseColumns = (names) => [
  { header: "Date", format: "date", width: 12, value: (e) => e.date },
  { header: "Category", format: "text", width: 20, value: categoryOf(names) },
  { header: "Provider / payee", format: "text", width: 24, value: (e) => e.payee },
  { header: "Amount", format: "money", width: 13, value: (e) => e.amount },
  { header: "Method", format: "text", width: 14, value: (e) => label(EXPENSE_METHODS, e.method) },
  { header: "Reference", format: "text", width: 16, value: (e) => e.reference },
  { header: "Recurring", format: "bool", width: 10, value: (e) => e.recurring === true },
  { header: "From payment schedule", format: "bool", width: 12, value: (e) => Boolean(e.scheduleId) },
  { header: "Notes", format: "text", width: 30, value: (e) => e.notes },
];

const PROVIDER_COLUMNS = [
  { header: "Name", format: "text", width: 26, value: (p) => p.name },
  { header: "Type", format: "text", width: 16, value: (p) => label(PROVIDER_TYPES, p.type) },
  { header: "Phone", format: "text", width: 16, value: (p) => p.phone },
  { header: "Email", format: "text", width: 24, value: (p) => p.email },
  { header: "Address / location", format: "text", width: 30, value: (p) => p.location },
  { header: "Notes", format: "text", width: 30, value: (p) => p.notes },
  { header: "Status", format: "text", width: 10, value: (p) => label(PROVIDER_STATUSES, p.status) },
];

export const scheduleColumns = (names) => [
  { header: "Due date", format: "date", width: 12, value: (s) => s.dueDate },
  { header: "Description", format: "text", width: 26, value: (s) => s.description },
  { header: "Category", format: "text", width: 20, value: categoryOf(names) },
  { header: "Provider / payee", format: "text", width: 24, value: (s) => s.payee },
  { header: "Amount", format: "money", width: 13, value: (s) => s.amount },
  { header: "Status", format: "text", width: 11, value: (s) => label(SCHEDULE_STATUSES, s.status) },
  { header: "Paid date", format: "date", width: 12, value: (s) => s.paidDate },
  { header: "Paid amount", format: "money", width: 13, value: (s) => s.paidAmount },
  { header: "Method", format: "text", width: 14, value: (s) => (s.method ? label(EXPENSE_METHODS, s.method) : "") },
  { header: "Reference", format: "text", width: 16, value: (s) => s.reference },
  { header: "Notes", format: "text", width: 30, value: (s) => s.notes },
];

// The overall budget, as of now: [label, format, value, note] pairs.
export function budgetPairs(doc, now) {
  const s = budgetSummary(doc);
  const money = (l, v, note) => (v === null ? [l, "text", NO_BUDGET, note] : [l, "money", v, note]);
  return [
    ["As of", "datetime", now, "Current figures at export time (no history is stored)"],
    money("Total budget", s.total, "Set on the Budget screen"),
    ["Total spent", "money", s.spent, "All active Baby Expenses"],
    money("Remaining budget", s.remaining, "Total budget − total spent"),
    ["Upcoming payments", "money", s.upcoming, `${s.upcomingCount} scheduled, not yet paid (not counted as spent)`],
  ];
}

async function readBudget(readByIds) {
  return (await readByIds("budgets", [BUDGET_DOC_ID])).get(BUDGET_DOC_ID) ?? null;
}

// Budget: the overall figures + one line per category (category / status filters).
async function budget({ filters, timezone, now, readRows, readByIds }) {
  const [doc, cats] = await Promise.all([readBudget(readByIds), categoryNames(readRows)]);
  const lines = budgetLines(doc, cats.rows).filter((l) => (!filters.category || l.id === filters.category) && (!filters.status || l.status === filters.status));
  return {
    rowCount: lines.length,
    sheets: [pairsSheet({ name: "Budget", timezone, rows: budgetPairs(doc, now) }), tableSheet({ name: "Category Budget", columns: CATEGORY_BUDGET_COLUMNS, rows: lines, timezone })],
    note: "Spent and Remaining are computed by Luna from the recorded Baby Expenses, as of export time.",
  };
}

async function babyExpenses({ filters, timezone, readRows }) {
  const [rows, cats] = await Promise.all([readRows("expenses", expensesQuery({ ...filters, status: "active" })), categoryNames(readRows)]);
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Baby Expenses", columns: babyExpenseColumns(cats.name), rows, timezone })] };
}

async function providers({ filters, timezone, readRows }) {
  const rows = await readRows("providers", providersQuery(filters));
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Providers", columns: PROVIDER_COLUMNS, rows, timezone })] };
}

async function paymentSchedule({ filters, timezone, readRows }) {
  const [rows, cats] = await Promise.all([readRows("scheduledPayments", scheduledPaymentsQuery(filters)), categoryNames(readRows)]);
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Payment Schedule", columns: scheduleColumns(cats.name), rows, timezone })], note: "Upcoming payments are committed money, not spending: they count as spent only once marked Paid." };
}

export const BABY_BUILDERS = Object.freeze({ budget, babyExpenses, providers, paymentSchedule });
