// Expenses (Phase 10), server side. Each write is ONE transaction that
// changes the expense, its history and the operating-expense metrics of
// the business-local day(s) and month(s) it touches:
//
//   create            +amount on its date
//   edit amount       +(new - old) on its date
//   edit date         -old on the old date, +new on the new date
//   remove            -amount on its date (the record stays, status removed)
//
// Metrics are FieldValue.increment writes on the day/month documents
// (no read), so expenses on different days never contend, and the same
// day's documents are only written, never read-modify-written here.
// Sales, COGS, payments, inventory and customers are never touched.

import { applyRollup, expenseContribution, diffRollup } from "./reports.js";
import { validateExpenseInput, ExpenseError, EXPENSE_SCHEMA_VERSION, expenseCategoryLabel, EXPENSE_METHODS } from "../../../shared/expenses.js";
import { businessDate } from "../../../shared/metrics.js";
import { recordDailyMetrics } from "./metrics.js";

const TX_OPTIONS = { maxAttempts: 10 };
const MAX_HISTORY_ENTRIES = 200;
const EXPENSE_ID = /^[A-Za-z0-9]{8,40}$/;

const peso = (c) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const methodLabel = (id) => EXPENSE_METHODS[id]?.label ?? id;

function expenseRef(tenant, id) {
  if (typeof id !== "string" || !EXPENSE_ID.test(id)) throw new ExpenseError("invalid-expense", "Invalid expense");
  return tenant.doc("expenses", id);
}

function append(history, entry) {
  const list = Array.isArray(history) ? history : [];
  if (list.length >= MAX_HISTORY_ENTRIES) throw new ExpenseError("history-full", "Too many changes on this record");
  return [...list, entry];
}

const opex = (tx, { tenant, FieldValue, timezone, day, delta }) => {
  if (delta) recordDailyMetrics({ tx, tenant, FieldValue, timezone, day, financial: { operatingExpenses: delta } });
};

// Plain-language change labels for the activity log.
function changeLabels(before, after) {
  const out = [];
  const show = {
    amount: (v) => peso(v),
    category: (v) => expenseCategoryLabel(v),
    method: (v) => methodLabel(v),
    recurring: (v) => (v ? "Yes" : "No"),
  };
  const names = { date: "Date", category: "Category", amount: "Amount", payee: "Payee", method: "Method", reference: "Reference", recurring: "Recurring" };
  for (const k of Object.keys(after)) {
    if (k === "notes") out.push("Notes updated");
    else out.push(`${names[k]} changed ${before[k] === null || before[k] === undefined ? "—" : (show[k] || String)(before[k])} → ${after[k] === null ? "—" : (show[k] || String)(after[k])}`);
  }
  return out.join(" · ");
}

export async function createExpense({ db, tenant, FieldValue, business, input, actor, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  const data = validateExpenseInput(input, { today });
  for (const k of ["date", "category", "amount", "method"]) if (data[k] === undefined) throw new ExpenseError("invalid-input", `${k} is required`);
  const ref = tenant.collection("expenses").doc();
  const stamp = FieldValue.serverTimestamp();
  await db.runTransaction(async (tx) => {
    tx.create(ref, {
      schemaVersion: EXPENSE_SCHEMA_VERSION,
      date: data.date,
      month: data.date.slice(0, 7),
      category: data.category,
      amount: data.amount,
      payee: data.payee ?? null,
      payeeLower: data.payee ? data.payee.toLocaleLowerCase("en") : null,
      method: data.method,
      reference: data.reference ?? null,
      notes: data.notes ?? null,
      recurring: data.recurring ?? false,
      status: "active",
      history: [{ type: "created", at: new Date(), actor, label: `Added ${expenseCategoryLabel(data.category)} expense ${peso(data.amount)}` }],
      revision: 1,
      createdBy: actor,
      createdAt: stamp,
      updatedBy: actor,
      updatedAt: stamp,
      removedBy: null,
      removedAt: null,
      removalReason: null,
    });
    opex(tx, { tenant, FieldValue, timezone: business.timezone, day: data.date, delta: data.amount });
    applyRollup(tx, { tenant, FieldValue, day: data.date, delta: expenseContribution(data) });
  }, TX_OPTIONS);
  return { expenseId: ref.id, date: data.date, amount: data.amount };
}

// Edit -> Save. Only the fields sent change; Luna reverses the old metric
// contribution and applies the new one in the same transaction.
export async function updateExpense({ db, tenant, FieldValue, business, expenseId, changes, expectedRevision = null, actor, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  const data = validateExpenseInput(changes, { partial: true, today });
  const ref = expenseRef(tenant, expenseId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ExpenseError("not-found", "Expense not found");
    const e = snap.data();
    if (e.status !== "active") throw new ExpenseError("removed", "A removed expense can't be edited");
    if (expectedRevision !== null && expectedRevision !== e.revision) throw new ExpenseError("stale-expense", "This expense was changed by someone else. Reload and try again");

    const diff = {};
    for (const [k, v] of Object.entries(data)) if ((e[k] ?? null) !== (v ?? null)) diff[k] = v ?? null;
    if (!Object.keys(diff).length) return { expenseId, unchanged: true, revision: e.revision };

    const update = { ...diff };
    if ("date" in diff) update.month = diff.date.slice(0, 7);
    if ("payee" in diff) update.payeeLower = diff.payee ? diff.payee.toLocaleLowerCase("en") : null;
    const before = Object.fromEntries(Object.keys(diff).map((k) => [k, e[k] ?? null]));
    tx.update(ref, {
      ...update,
      history: append(e.history, { type: "edited", at: new Date(), actor, changes: Object.fromEntries(Object.keys(diff).map((k) => [k, { from: before[k], to: diff[k] }])), label: changeLabels(before, diff) }),
      revision: e.revision + 1,
      updatedBy: actor,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const newDate = diff.date ?? e.date;
    const newAmount = diff.amount ?? e.amount;
    // Report rollups (category / method): restate the old and new days.
    const after = expenseContribution({ ...e, ...diff });
    if (newDate !== e.date) {
      applyRollup(tx, { tenant, FieldValue, day: e.date, delta: diffRollup({}, expenseContribution(e)) });
      applyRollup(tx, { tenant, FieldValue, day: newDate, delta: after });
    } else applyRollup(tx, { tenant, FieldValue, day: e.date, delta: diffRollup(after, expenseContribution(e)) });
    if (newDate !== e.date) {
      opex(tx, { tenant, FieldValue, timezone: business.timezone, day: e.date, delta: -e.amount });
      opex(tx, { tenant, FieldValue, timezone: business.timezone, day: newDate, delta: newAmount });
    } else {
      opex(tx, { tenant, FieldValue, timezone: business.timezone, day: e.date, delta: newAmount - e.amount });
    }
    return { expenseId, revision: e.revision + 1, date: newDate, amount: newAmount };
  }, TX_OPTIONS);
}

// ⋯ More -> Remove expense (reason required). Kept for audit, stops counting.
export async function removeExpense({ db, tenant, FieldValue, business, expenseId, reason, actor }) {
  const why = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ") : "";
  if (why.length < 3 || why.length > 300) throw new ExpenseError("reason-required", "Say why this expense is being removed (3-300 characters)");
  const ref = expenseRef(tenant, expenseId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ExpenseError("not-found", "Expense not found");
    const e = snap.data();
    if (e.status !== "active") throw new ExpenseError("removed", "This expense is already removed");
    const stamp = FieldValue.serverTimestamp();
    tx.update(ref, {
      status: "removed",
      removedBy: actor,
      removedAt: stamp,
      removalReason: why,
      history: append(e.history, { type: "removed", at: new Date(), actor, reason: why, label: `Removed expense ${peso(e.amount)}` }),
      revision: e.revision + 1,
      updatedBy: actor,
      updatedAt: stamp,
    });
    opex(tx, { tenant, FieldValue, timezone: business.timezone, day: e.date, delta: -e.amount });
    applyRollup(tx, { tenant, FieldValue, day: e.date, delta: diffRollup({}, expenseContribution(e)) });
    return { expenseId, removed: true };
  }, TX_OPTIONS);
}

export { ExpenseError };
