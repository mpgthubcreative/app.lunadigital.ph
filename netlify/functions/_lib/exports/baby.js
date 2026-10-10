// Phase 15 Baby Expense Tracker workbooks, through the Export Core
// (runExport): the same list specs as the screens (shared/list-queries.js),
// every matching row, refused past the row limit. Baby columns only: no
// sales, COGS, profit or other Distributor field ever appears.
//
// Category names: an expense / payment keeps the name it was recorded with
// (categoryName); the workbook shows the category's CURRENT name (as the
// screens do), falling back to that snapshot. Provider names stay the
// snapshot, so history reads as it was paid.
//
// Phase 18.6: ONE worksheet per download. The Budget download is the full
// Baby report: a "Category" row per budget line (budget / spent /
// remaining), every paid "Expense" (amount, who paid, provider, payee...)
// and every payment "Still to pay" (only its unpaid part). Each amount has
// its own column, so the totals never count anything twice: total spent
// (Category rows) equals the total of the Expense rows' payment amounts.

import { expensesQuery, categoriesQuery, providersQuery, scheduledPaymentsQuery } from "../../../../shared/list-queries.js";
import { EXPENSE_METHODS } from "../../../../shared/expenses.js";
import { BUDGET_DOC_ID, CATEGORY_STATUSES, PROVIDER_TYPES, PROVIDER_STATUSES, SCHEDULE_STATUSES, budgetSummary, budgetLines, sortCategories, upcomingPart, PAYER_NOT_SET } from "../../../../shared/baby.js";

const label = (map, key) => map[key]?.label ?? key ?? "";
const NO_BUDGET = "No budget set";

// Every category (at most MAX_CATEGORIES) -> id -> current name.
async function categoryNames(readRows) {
  const rows = await readRows("expenseCategories", categoriesQuery());
  return { rows: sortCategories(rows), name: new Map(rows.map((c) => [c.id, c.name])) };
}
const categoryOf = (names) => (r) => names.get(r.category) ?? r.categoryName ?? "";
const providerOf = (e) => (e.providerId ? e.providerName ?? e.payee ?? "" : "");
const payeeOf = (e) => e.payee || providerOf(e) || "";
const paidByOf = (e) => (Array.isArray(e.paidBy) && e.paidBy.length ? e.paidBy.map((p) => (e.paidBy.length > 1 ? `${p.name} ₱${(p.amount / 100).toFixed(2)}` : p.name)).join(" + ") : PAYER_NOT_SET);
const scheduleState = (s) => (s.status === "upcoming" && (s.paidAmount ?? 0) > 0 ? "Part paid" : label(SCHEDULE_STATUSES, s.status));

export const CATEGORY_BUDGET_COLUMNS = [
  { header: "Category", format: "text", width: 24, value: (l) => l.name },
  { header: "Shown / hidden", format: "text", width: 10, value: (l) => (l.status === "active" ? "Shown" : "Hidden") },
  { header: "Category budget", format: "money", width: 14, total: true, value: (l) => l.budget },
  { header: "Total spent", format: "money", width: 14, total: true, value: (l) => l.spent },
  { header: "Budget left", format: "money", width: 14, total: true, value: (l) => l.remaining },
  { header: "% used", format: "percent", width: 9, value: (l) => (l.percentUsed === null ? null : l.percentUsed / 100) },
  { header: "Still to pay", format: "money", width: 14, total: true, value: (l) => l.upcoming },
];

export const babyExpenseColumns = (names) => [
  { header: "Date paid", format: "date", width: 12, value: (e) => e.date },
  { header: "Category", format: "text", width: 20, value: categoryOf(names) },
  { header: "What it was for", format: "text", width: 30, value: (e) => e.notes },
  { header: "Amount", format: "money", width: 13, total: true, value: (e) => e.amount },
  { header: "Paid by", format: "text", width: 22, value: paidByOf },
  { header: "Provider", format: "text", width: 22, value: providerOf },
  { header: "Paid to (payee)", format: "text", width: 22, value: payeeOf },
  { header: "Payment method", format: "text", width: 14, value: (e) => label(EXPENSE_METHODS, e.method) },
  { header: "Reference", format: "text", width: 16, value: (e) => e.reference },
  { header: "Recurring", format: "bool", width: 10, value: (e) => e.recurring === true },
  { header: "From payment schedule", format: "bool", width: 12, value: (e) => Boolean(e.scheduleId) },
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
  { header: "Paid to (payee)", format: "text", width: 24, value: (s) => s.payee },
  { header: "Amount", format: "money", width: 13, value: (s) => s.amount },
  { header: "Paid so far", format: "money", width: 13, total: true, value: (s) => s.paidAmount ?? 0 },
  { header: "Still to pay", format: "money", width: 13, total: true, value: (s) => upcomingPart(s) },
  { header: "Status", format: "text", width: 11, value: scheduleState },
  { header: "Date paid", format: "date", width: 12, value: (s) => s.paidDate },
  { header: "Payment method", format: "text", width: 14, value: (s) => (s.method ? label(EXPENSE_METHODS, s.method) : "") },
  { header: "Reference", format: "text", width: 16, value: (s) => s.reference },
  { header: "Notes", format: "text", width: 30, value: (s) => s.notes },
];

// The full Baby report (Budget download): one row per category, expense
// and unpaid scheduled payment.
const REPORT_COLUMNS = (names) => [
  { header: "Record", format: "text", width: 12, value: (r) => r.record },
  { header: "Date", format: "date", width: 12, value: (r) => (r.record === "Expense" ? r.e.date : r.record === "Still to pay" ? r.s.dueDate : null) },
  { header: "Category", format: "text", width: 20, value: (r) => (r.record === "Category" ? r.l.name : r.record === "Expense" ? categoryOf(names)(r.e) : categoryOf(names)(r.s)) },
  { header: "Description / item", format: "text", width: 30, value: (r) => (r.record === "Expense" ? r.e.notes : r.record === "Still to pay" ? r.s.description : r.l.status === "active" ? null : "Hidden category") },
  { header: "Category budget", format: "money", width: 14, total: true, value: (r) => (r.record === "Category" ? r.l.budget : null) },
  { header: "Total spent", format: "money", width: 14, total: true, value: (r) => (r.record === "Category" ? r.l.spent : null) },
  { header: "Budget left", format: "money", width: 14, total: true, value: (r) => (r.record === "Category" ? r.l.remaining : null) },
  { header: "Payment amount", format: "money", width: 13, total: true, value: (r) => (r.record === "Expense" ? r.e.amount : null) },
  { header: "Still to pay", format: "money", width: 13, total: true, value: (r) => (r.record === "Still to pay" ? upcomingPart(r.s) : null) },
  { header: "Payment status", format: "text", width: 12, value: (r) => (r.record === "Expense" ? "Paid" : r.record === "Still to pay" ? (r.s.dueDate < r.today ? "Overdue" : scheduleState(r.s)) : null) },
  { header: "Payment method", format: "text", width: 14, value: (r) => (r.record === "Expense" ? label(EXPENSE_METHODS, r.e.method) : null) },
  { header: "Paid by", format: "text", width: 22, value: (r) => (r.record === "Expense" ? paidByOf(r.e) : null) },
  { header: "Provider", format: "text", width: 22, value: (r) => (r.record === "Expense" ? providerOf(r.e) : r.record === "Still to pay" && r.s.providerId ? r.s.payee : null) },
  { header: "Payee", format: "text", width: 22, value: (r) => (r.record === "Expense" ? payeeOf(r.e) : r.record === "Still to pay" ? r.s.payee : null) },
  { header: "Due date", format: "date", width: 12, value: (r) => (r.record === "Still to pay" ? r.s.dueDate : null) },
  { header: "Date paid", format: "date", width: 12, value: (r) => (r.record === "Expense" ? r.e.date : null) },
  { header: "Reference", format: "text", width: 16, value: (r) => (r.record === "Expense" ? r.e.reference : null) },
  { header: "Notes", format: "text", width: 30, value: (r) => (r.record === "Still to pay" ? [r.s.notes, (r.s.paidAmount ?? 0) > 0 ? `₱${(r.s.paidAmount / 100).toFixed(2)} of ₱${(r.s.amount / 100).toFixed(2)} already paid` : null].filter(Boolean).join(" · ") || null : r.record === "Expense" && r.e.scheduleId ? "From the payment schedule" : null) },
];

// The overall budget, as of now: [label, format, value, note] pairs.
export function budgetPairs(doc, now) {
  const s = budgetSummary(doc);
  const money = (l, v, note) => (v === null ? [l, "text", NO_BUDGET, note] : [l, "money", v, note]);
  return [
    ["As of", "datetime", now, "Current figures at export time (no history is stored)"],
    money("Total budget", s.total, "Sum of the category budgets"),
    ["Total spent", "money", s.spent, "All active Baby Expenses"],
    money("Budget left", s.remaining, "Total budget − total spent"),
    ["Still to pay", "money", s.upcoming, `${s.upcomingCount} scheduled, not yet paid (not counted as spent)`],
  ];
}

async function readBudget(readByIds) {
  return (await readByIds("budgets", [BUDGET_DOC_ID])).get(BUDGET_DOC_ID) ?? null;
}

// Budget: the full report (category / status filters choose the categories).
async function budget({ filters, today, readRows, readByIds }) {
  const [doc, cats] = await Promise.all([readBudget(readByIds), categoryNames(readRows)]);
  const lines = budgetLines(doc, cats.rows).filter((l) => (!filters.category || l.id === filters.category) && (!filters.status || l.status === filters.status));
  const ids = new Set(lines.map((l) => l.id));
  const [expenses, schedule] = await Promise.all([readRows("expenses", expensesQuery({ status: "active", ...(filters.category ? { category: filters.category } : {}) })), readRows("scheduledPayments", scheduledPaymentsQuery({ status: "upcoming", ...(filters.category ? { category: filters.category } : {}) }))]);
  const rows = [
    ...lines.map((l) => ({ record: "Category", l })),
    ...expenses.filter((e) => ids.has(e.category)).sort((a, b) => (a.date < b.date ? -1 : 1)).map((e) => ({ record: "Expense", e })),
    ...schedule.filter((s) => ids.has(s.category) && upcomingPart(s) > 0).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1)).map((s) => ({ record: "Still to pay", s, today })),
  ];
  const s = budgetSummary(doc);
  return {
    rowCount: rows.length,
    table: { name: "Baby budget", columns: REPORT_COLUMNS(cats.name), rows },
    note: `Total budget ${s.total === null ? "not set" : `₱${(s.total / 100).toFixed(2)}`} (sum of category budgets) · spent ₱${(s.spent / 100).toFixed(2)} · still to pay ₱${(s.upcoming / 100).toFixed(2)}. Scheduled payments count as spent only once paid.`,
  };
}

async function babyExpenses({ filters, readRows }) {
  const [rows, cats] = await Promise.all([readRows("expenses", expensesQuery({ ...filters, status: "active" })), categoryNames(readRows)]);
  return { rowCount: rows.length, table: { name: "Baby Expenses", columns: babyExpenseColumns(cats.name), rows }, note: "A shared expense is one row; Paid by shows each person's share." };
}

async function providers({ filters, readRows }) {
  const rows = await readRows("providers", providersQuery(filters));
  return { rowCount: rows.length, table: { name: "Providers", columns: PROVIDER_COLUMNS, rows } };
}

async function paymentSchedule({ filters, readRows }) {
  const [rows, cats] = await Promise.all([readRows("scheduledPayments", scheduledPaymentsQuery(filters)), categoryNames(readRows)]);
  return { rowCount: rows.length, table: { name: "Payment Schedule", columns: scheduleColumns(cats.name), rows }, note: "Still to pay is committed money, not spending: it counts as spent only once paid. Parts already paid are in Paid so far." };
}

export const BABY_BUILDERS = Object.freeze({ budget, babyExpenses, providers, paymentSchedule });
