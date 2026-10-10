// Expenses Core (Phase 10; workspace profiles Phase 15), server side.
//
// The RECORD behaviour is shared by every workspace that has the Expenses
// module: validation (integer centavos, business-local dates, no future
// dates), the record and its history, Edit -> Save with revisions, audited
// removal. What an expense COUNTS AS is the workspace's "sink", chosen from
// the business's validated workspace (never a default):
//
//   distributor   Operating Expenses: financialMetrics/{day,month}
//                 operatingExpenses + the report rollups (category /
//                 method). Exactly the Phase 10 behaviour:
//                   create        +amount on its date
//                   edit amount   +(new - old) on its date
//                   edit date     -old on the old date, +new on the new date
//                   remove        -amount on its date (record kept, removed)
//                 Metric writes are FieldValue.increment (no read), so
//                 expenses on different days never contend. Sales, COGS,
//                 payments, inventory and customers are never touched.
//   baby-expense  Baby spending: budgets/current + spendingMetrics (see
//                 ./baby-spending.js). Never sales, COGS or profit.
//   bridal-expense  Wedding spending: the same budget primitive + supplier
//                 paid totals (./wedding-spending.js). Never sales, COGS,
//                 profit or Baby figures (each business has its own data).
//
// Each write is ONE transaction: the engine's reads, then the sink's reads
// (prepare), then every write (commit).

import { applyRollup, expenseContribution, diffRollup } from "./reports.js";
import { validateExpenseInput, ExpenseError, EXPENSE_SCHEMA_VERSION, expenseCategoryLabel, expenseProfile, EXPENSE_METHODS } from "../../../shared/expenses.js";
import { businessDate } from "../../../shared/metrics.js";
import { recordDailyMetrics } from "./metrics.js";
import { babySpendingSink } from "./baby-spending.js";
import { weddingSpendingSink } from "./wedding-spending.js";
import { meterActivity } from "./metering.js";

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

// ---------- Sinks ----------

const opex = (tx, { tenant, FieldValue, timezone, day, delta }) => {
  if (delta) recordDailyMetrics({ tx, tenant, FieldValue, timezone, day, financial: { operatingExpenses: delta } });
};

// Distributor: operating expenses + report rollups (Phase 10 / 11), no reads.
const distributorSink = {
  categoryLabel: (e) => expenseCategoryLabel(e.category),
  async prepare(tx, { tenant, business, before, after }) {
    const timezone = business.timezone;
    return {
      fields: {},
      commit({ FieldValue }) {
        const rollup = (day, delta) => applyRollup(tx, { tenant, FieldValue, day, delta });
        const op = (day, delta) => opex(tx, { tenant, FieldValue, timezone, day, delta });
        if (!before) {
          op(after.date, after.amount);
          rollup(after.date, expenseContribution(after));
        } else if (!after) {
          op(before.date, -before.amount);
          rollup(before.date, diffRollup({}, expenseContribution(before)));
        } else {
          // Report rollups (category / method): restate the old and new days.
          const next = expenseContribution(after);
          if (after.date !== before.date) {
            rollup(before.date, diffRollup({}, expenseContribution(before)));
            rollup(after.date, next);
            op(before.date, -before.amount);
            op(after.date, after.amount);
          } else {
            rollup(before.date, diffRollup(next, expenseContribution(before)));
            op(before.date, after.amount - before.amount);
          }
        }
      },
    };
  },
};

const SINKS = { distributor: distributorSink, "baby-expense": babySpendingSink, "bridal-expense": weddingSpendingSink };

// The workspace's profile + sink, or a refusal (no workspace default).
function profileOf(workspace) {
  const profile = expenseProfile(workspace);
  const sink = profile && SINKS[profile.id];
  if (!sink) throw new ExpenseError("not-available", "Expenses aren't available in this workspace");
  return { profile, sink };
}

// Plain-language change labels for the activity log.
function changeLabels(before, after, categoryLabel) {
  const out = [];
  const show = {
    amount: (v) => peso(v),
    category: (v, rec) => categoryLabel(rec),
    method: (v) => methodLabel(v),
    recurring: (v) => (v ? "Yes" : "No"),
  };
  show.paidBy = (v) => (Array.isArray(v) && v.length ? v.map((p) => (v.length > 1 ? `${p.name} ${peso(p.amount)}` : p.name)).join(" + ") : "—");
  const names = { date: "Date", category: "Category", amount: "Amount", payee: "Payee", method: "Method", reference: "Reference", recurring: "Recurring", paidBy: "Paid by", providerName: "Provider" };
  for (const k of Object.keys(after)) {
    if (k === "notes") out.push("Notes updated");
    else if (names[k]) {
      const fmt = (v, rec) => (v === null || v === undefined ? "—" : (show[k] || String)(v, rec));
      out.push(`${names[k]} changed ${fmt(before[k], before)} → ${fmt(after[k], { ...before, ...after })}`);
    }
  }
  return out.join(" · ");
}

// ---------- Create ----------

// Inside a caller's transaction (all reads happen here, writes in commit):
// the Baby Payment Schedule records the expense of a payment marked Paid
// in the same transaction as the payment's status (./baby.js). `expenseId`
// fixes the document id (create-once); `link` is server-set provenance.
export async function prepareExpenseCreate(tx, { tenant, business, workspace, input, actor, now = new Date(), expenseId = null, link = null, upcomingDelta = null }) {
  const { profile, sink } = profileOf(workspace);
  const today = businessDate(business.timezone, now);
  const data = validateExpenseInput(input, { today, profile });
  for (const k of ["date", "category", "amount", "method"]) if (data[k] === undefined) throw new ExpenseError("invalid-input", `${k} is required`);
  const ref = expenseId ? expenseRef(tenant, expenseId) : tenant.collection("expenses").doc();
  const after = { id: ref.id, ...data, ...(profile.ref ? { [profile.ref]: data[profile.ref] ?? null, [profile.link]: link?.[profile.link] ?? null } : {}) };
  const s = await sink.prepare(tx, { tenant, business, before: null, after, actor, now, upcomingDelta });
  const rec = { ...after, ...s.fields };
  return {
    ref,
    record: rec,
    commit({ FieldValue }) {
      const stamp = FieldValue.serverTimestamp();
      const payee = rec.payee ?? null;
      tx.create(ref, {
        schemaVersion: EXPENSE_SCHEMA_VERSION,
        date: rec.date,
        month: rec.date.slice(0, 7),
        category: rec.category,
        ...(rec.categoryName !== undefined ? { categoryName: rec.categoryName } : {}),
        // Phase 18.6 (Baby): the saved provider's name snapshot and who paid.
        ...(rec.providerName !== undefined ? { providerName: rec.providerName } : {}),
        ...(profile.payers ? { paidBy: rec.paidBy ?? null } : {}),
        amount: rec.amount,
        payee,
        payeeLower: payee ? payee.toLocaleLowerCase("en") : null,
        ...(profile.ref ? { [profile.ref]: rec[profile.ref] ?? null, [profile.link]: rec[profile.link] ?? null } : {}),
        method: rec.method,
        reference: rec.reference ?? null,
        notes: rec.notes ?? null,
        recurring: rec.recurring ?? false,
        status: "active",
        history: [{ type: "created", at: new Date(), actor, label: link?.label ?? `Added ${sink.categoryLabel(rec)} expense ${peso(rec.amount)}` }],
        revision: 1,
        createdBy: actor,
        createdAt: stamp,
        updatedBy: actor,
        updatedAt: stamp,
        removedBy: null,
        removedAt: null,
        removalReason: null,
      });
      s.commit({ FieldValue });
      // Phase 18 activity meter, in the same transaction as the record.
      meterActivity(tx, { tenant, FieldValue, timezone: business.timezone, now, counts: { expensesCreated: 1 } });
    },
  };
}

export async function createExpense({ db, tenant, FieldValue, business, workspace, input, actor, now = new Date() }) {
  return db.runTransaction(async (tx) => {
    const plan = await prepareExpenseCreate(tx, { tenant, business, workspace, input, actor, now });
    plan.commit({ FieldValue });
    return { expenseId: plan.ref.id, date: plan.record.date, amount: plan.record.amount };
  }, TX_OPTIONS);
}

// ---------- Edit -> Save ----------

// Only the fields sent change; the sink reverses the old contribution and
// applies the new one in the same transaction.
export async function updateExpense({ db, tenant, FieldValue, business, workspace, expenseId, changes, expectedRevision = null, actor, now = new Date() }) {
  const { profile, sink } = profileOf(workspace);
  const today = businessDate(business.timezone, now);
  const data = validateExpenseInput(changes, { partial: true, today, profile });
  const ref = expenseRef(tenant, expenseId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ExpenseError("not-found", "Expense not found");
    const e = snap.data();
    if (e.status !== "active") throw new ExpenseError("removed", "A removed expense can't be edited");
    if (expectedRevision !== null && expectedRevision !== e.revision) throw new ExpenseError("stale-expense", "This expense was changed by someone else. Reload and try again");

    const diff = {};
    // JSON comparison so list fields (paidBy) compare by value.
    for (const [k, v] of Object.entries(data)) if (JSON.stringify(e[k] ?? null) !== JSON.stringify(v ?? null)) diff[k] = v ?? null;
    if (!Object.keys(diff).length) return { expenseId, unchanged: true, revision: e.revision };

    const before = { id: expenseId, ...e };
    const s = await sink.prepare(tx, { tenant, business, before, after: { ...before, ...diff }, actor, now });
    const update = { ...diff, ...s.fields };
    if ("date" in update) update.month = update.date.slice(0, 7);
    if ("payee" in update) update.payeeLower = update.payee ? update.payee.toLocaleLowerCase("en") : null;
    const shown = Object.fromEntries(Object.entries(update).filter(([k]) => k in diff || k === "payee" || k === "paidBy" || k === "providerName"));
    const was = Object.fromEntries(Object.keys(shown).map((k) => [k, e[k] ?? null]));
    tx.update(ref, {
      ...update,
      history: append(e.history, { type: "edited", at: new Date(), actor, changes: Object.fromEntries(Object.keys(shown).map((k) => [k, { from: was[k], to: shown[k] }])), label: changeLabels({ ...e, ...was }, shown, sink.categoryLabel) }),
      revision: e.revision + 1,
      updatedBy: actor,
      updatedAt: FieldValue.serverTimestamp(),
    });
    s.commit({ FieldValue });
    return { expenseId, revision: e.revision + 1, date: update.date ?? e.date, amount: update.amount ?? e.amount };
  }, TX_OPTIONS);
}

// ---------- Remove ----------

// ⋯ More -> Remove expense (reason required). Kept for audit, stops counting.
export async function removeExpense({ db, tenant, FieldValue, business, workspace, expenseId, reason, actor, now = new Date() }) {
  const { sink } = profileOf(workspace);
  const why = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ") : "";
  if (why.length < 3 || why.length > 300) throw new ExpenseError("reason-required", "Say why this expense is being removed (3-300 characters)");
  const ref = expenseRef(tenant, expenseId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ExpenseError("not-found", "Expense not found");
    const e = snap.data();
    if (e.status !== "active") throw new ExpenseError("removed", "This expense is already removed");
    const s = await sink.prepare(tx, { tenant, business, before: { id: expenseId, ...e }, after: null, actor, now });
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
    s.commit({ FieldValue });
    return { expenseId, removed: true, ...(s.result || {}) };
  }, TX_OPTIONS);
}

export { ExpenseError };
