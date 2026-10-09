// Wedding spending sink (Phase 16): what a Wedding Expense counts as. Called
// by the Expenses Core (./expenses.js) inside the expense's transaction:
// prepare() does every read, commit() every write. Same budget primitive as
// Baby (budgets/current, spendingMetrics, expenseCategories), plus the
// wedding's suppliers:
//
//   budgets/current          spent, expenseCount, spentByCategory (active
//                            Wedding Expenses); contractedPaid (paid to
//                            suppliers that have an agreed amount)
//   spendingMetrics/{day}    spent, count, byCategory, supplierPaid for the
//   spendingMetrics/{month}  Dashboard's selected period
//   expenseCategories/{id}   useCount +1 when an expense starts using it
//   weddingSuppliers/{id}    paid = the supplier's active Wedding Expenses
//
// Agreed-amount policy (deterministic): a supplier with an agreed amount
// can never be paid more than it. A change that would do so is refused
// (over-agreed); raise the agreed amount first (audited).
//
// An expense recorded from a supplier payment (supplierPaymentId):
//   edit amount  -> the payment's paidAmount follows
//   remove       -> the payment goes back to Upcoming (counted in Upcoming
//                   again); marking it Paid later records a NEW expense
//   its supplier can't change (the payment belongs to that supplier)
// Notifications: 75 / 90 / 100% of the wedding budget, once per level per
// budget episode (budget.threshold, Notifications Core).

import { ExpenseError } from "../../../shared/expenses.js";
import { BUDGET_DOC_ID, thresholdLevel } from "../../../shared/baby.js";
import { WEDDING_SCHEMA_VERSION } from "../../../shared/wedding.js";
import { prepareNotifications } from "./notifications.js";

const MAX_HISTORY = 200;
const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const peso = (c) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const budgetRef = (tenant) => tenant.doc("budgets", BUDGET_DOC_ID);
const bump = (map, key, amount) => {
  if (key && amount) map[key] = (map[key] || 0) + amount;
};
function appendHistory(list, entry) {
  const l = Array.isArray(list) ? list : [];
  if (l.length >= MAX_HISTORY) throw new ExpenseError("history-full", "Too many changes on this record");
  return [...l, entry];
}
const who = (actor) => (actor ? { uid: actor.uid, name: actor.name } : null);

// alerts = { episode, notified } on budgets/current (same scheme as Baby).
function weddingAlerts(budget, spentAfter, notify) {
  const alerts = budget?.alerts && typeof budget.alerts === "object" ? budget.alerts : {};
  const episode = Number.isSafeInteger(alerts.episode) && alerts.episode > 0 ? alerts.episode : 1;
  const notified = Number.isSafeInteger(alerts.notified) ? alerts.notified : 0;
  const total = Number.isSafeInteger(budget?.total) ? budget.total : null;
  const level = thresholdLevel(spentAfter, total);
  if (!notify || level <= notified) return { alerts: { episode, notified }, event: null };
  return {
    alerts: { episode, notified: level },
    event: {
      type: "budget.threshold",
      key: `${episode}-${level}`,
      title: level >= 100 ? "Wedding budget fully used" : `Wedding budget ${level}% used`,
      message: `${peso(spentAfter)} of your ${peso(total)} wedding budget has been spent.`,
      recordType: "budget",
      recordId: BUDGET_DOC_ID,
    },
  };
}

export const weddingSpendingSink = {
  categoryLabel: (e) => e.categoryName ?? "Uncategorized",

  // upcomingDelta: a Supplier Payment change made in the same transaction
  // ({ amount, count, category, supplierId, nextDue? }), folded into the ONE
  // budgets/current write and the ONE write per supplier.
  async prepare(tx, { tenant, before, after, actor, upcomingDelta: extraUpcoming = null }) {
    const fromPayment = !before && Boolean(after?.supplierPaymentId);
    if (before && after && before.supplierPaymentId && (after.supplierId ?? null) !== (before.supplierId ?? null)) {
      throw new ExpenseError("invalid-input", "This expense was recorded from a supplier payment: its supplier can't change");
    }
    const usable = (snap) => snap.exists && (snap.data().status === "active" || fromPayment);
    const intoCategory = after && (!before || after.category !== before.category) ? after.category : null;
    const intoSupplier = after && after.supplierId && (!before || after.supplierId !== before.supplierId) ? after.supplierId : null;
    const supplierIds = [...new Set([before?.supplierId, after?.supplierId, extraUpcoming?.supplierId].filter(Boolean))];
    const paymentId = before?.supplierPaymentId ?? null;
    const catRef = intoCategory ? tenant.doc("expenseCategories", intoCategory) : null;
    const payRef = paymentId ? tenant.doc("supplierPayments", paymentId) : null;
    const [budgetSnap, catSnap, paySnap, ...supplierSnaps] = await Promise.all([tx.get(budgetRef(tenant)), catRef && tx.get(catRef), payRef && tx.get(payRef), ...supplierIds.map((id) => tx.get(tenant.doc("weddingSuppliers", id)))]);
    const suppliers = Object.fromEntries(supplierIds.map((id, i) => [id, supplierSnaps[i].exists ? supplierSnaps[i].data() : null]));

    const fields = {};
    if (catRef) {
      if (!usable(catSnap)) throw new ExpenseError("invalid-category", "Choose an active category");
      fields.categoryName = catSnap.data().name;
    }
    if (after && after.supplierId) {
      if (intoSupplier) {
        const s = suppliers[intoSupplier];
        if (!s || (s.status !== "active" && !fromPayment)) throw new ExpenseError("invalid-supplier", "Choose an active supplier");
        fields.payee = s.name; // the supplier's name, kept as it was when paid
      } else if (before && after.payee !== before.payee) throw new ExpenseError("invalid-input", "This expense is linked to a saved supplier: change the supplier instead of the payee");
    }

    // Supplier paid deltas, and the agreed-amount cap.
    const paidBy = {};
    if (before?.supplierId) bump(paidBy, before.supplierId, -before.amount);
    if (after?.supplierId) bump(paidBy, after.supplierId, after.amount);
    let contractedPaid = 0;
    for (const [id, delta] of Object.entries(paidBy)) {
      const s = suppliers[id];
      if (!s || !delta) continue;
      if (Number.isSafeInteger(s.agreedAmount)) {
        if (delta > 0 && int(s.paid) + delta > s.agreedAmount) throw new ExpenseError("over-agreed", `That would pay ${s.name} ${peso(int(s.paid) + delta)}, more than the agreed ${peso(s.agreedAmount)}. Update the agreed amount first`);
        contractedPaid += delta;
      }
    }

    // Spending deltas: the old contribution out, the new one in.
    const spentBy = {};
    const days = {};
    const day = (d) => (days[d] = days[d] || { spent: 0, count: 0, supplierPaid: 0, byCategory: {} });
    for (const [rec, sign] of [[before, -1], [after, 1]]) {
      if (!rec) continue;
      bump(spentBy, rec.category, sign * rec.amount);
      const x = day(rec.date);
      x.spent += sign * rec.amount;
      x.count += sign;
      if (rec.supplierId) x.supplierPaid += sign * rec.amount;
      bump(x.byCategory, rec.category, sign * rec.amount);
    }
    const dSpent = (after?.amount ?? 0) - (before?.amount ?? 0);
    const dCount = (after ? 1 : 0) - (before ? 1 : 0);
    const budget = budgetSnap.exists ? budgetSnap.data() : null;
    const { alerts, event } = weddingAlerts(budget, int(budget?.spent) + dSpent, dSpent > 0);
    const notes = await prepareNotifications(tx, { tenant, actor, events: event ? [event] : [] });

    // The supplier payment this expense came from.
    const pay = paySnap && paySnap.exists ? paySnap.data() : null;
    const linked = pay && pay.status === "paid" && pay.expenseId === before.id;
    const reopen = linked && !after;
    const up = { amount: 0, count: 0, byCategory: {} };
    const supplierUp = {}; // supplierId -> { amount, count, nextDue? }
    const addUp = (amount, count, category, supplierId, nextDue) => {
      up.amount += amount;
      up.count += count;
      bump(up.byCategory, category, amount);
      if (supplierId) {
        const x = (supplierUp[supplierId] = supplierUp[supplierId] || { amount: 0, count: 0 });
        x.amount += amount;
        x.count += count;
        if (nextDue !== undefined) x.nextDue = nextDue;
      }
    };
    if (extraUpcoming) addUp(extraUpcoming.amount, extraUpcoming.count, extraUpcoming.category, extraUpcoming.supplierId, extraUpcoming.nextDue);
    if (reopen) {
      const s = suppliers[pay.supplierId];
      const nd = s && s.nextDue && s.nextDue < pay.dueDate ? s.nextDue : pay.dueDate;
      addUp(pay.amount, 1, pay.category, pay.supplierId, nd);
    }

    return {
      fields,
      result: reopen ? { paymentReopened: paymentId } : undefined,
      commit({ FieldValue }) {
        const inc = (n) => FieldValue.increment(n);
        const stamp = FieldValue.serverTimestamp();
        const incMap = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v).map(([k, v]) => [k, inc(v)]));
        tx.set(
          budgetRef(tenant),
          {
            schemaVersion: WEDDING_SCHEMA_VERSION,
            spent: inc(dSpent),
            expenseCount: inc(dCount),
            spentByCategory: incMap(spentBy),
            ...(contractedPaid ? { contractedPaid: inc(contractedPaid) } : {}),
            ...(up.amount || up.count ? { upcoming: inc(up.amount), upcomingCount: inc(up.count), upcomingByCategory: incMap(up.byCategory) } : {}),
            alerts,
            updatedAt: stamp,
          },
          { merge: true }
        );
        for (const [d, v] of Object.entries(days)) {
          if (!v.spent && !v.count) continue;
          const body = { spent: inc(v.spent), count: inc(v.count), supplierPaid: inc(v.supplierPaid), byCategory: incMap(v.byCategory), updatedAt: stamp };
          tx.set(tenant.doc("spendingMetrics", d), { schemaVersion: WEDDING_SCHEMA_VERSION, period: "day", id: d, ...body }, { merge: true });
          tx.set(tenant.doc("spendingMetrics", d.slice(0, 7)), { schemaVersion: WEDDING_SCHEMA_VERSION, period: "month", id: d.slice(0, 7), ...body }, { merge: true });
        }
        if (catRef) tx.update(catRef, { useCount: inc(1) });
        // One write per supplier: paid, upcoming, next due.
        for (const id of supplierIds) {
          if (!suppliers[id]) continue;
          const u = supplierUp[id];
          const change = {
            ...(paidBy[id] ? { paid: inc(paidBy[id]) } : {}),
            ...(u && (u.amount || u.count) ? { upcoming: inc(u.amount), upcomingCount: inc(u.count) } : {}),
            ...(u && u.nextDue !== undefined ? { nextDue: u.nextDue } : {}),
          };
          if (Object.keys(change).length) tx.update(tenant.doc("weddingSuppliers", id), { ...change, updatedAt: stamp });
        }
        if (linked && after && after.amount !== before.amount) {
          tx.update(payRef, { paidAmount: after.amount, history: appendHistory(pay.history, { at: new Date(), actor: who(actor), label: `Paid amount changed ${peso(before.amount)} → ${peso(after.amount)} (expense edited)` }), revision: int(pay.revision) + 1, updatedBy: who(actor), updatedAt: stamp });
        }
        if (reopen) {
          tx.update(payRef, {
            status: "upcoming",
            expenseId: null,
            paidDate: null,
            paidAmount: null,
            method: null,
            reference: null,
            attempt: int(pay.attempt) + 1,
            history: appendHistory(pay.history, { at: new Date(), actor: who(actor), label: "Its expense was removed: back to Upcoming" }),
            revision: int(pay.revision) + 1,
            updatedBy: who(actor),
            updatedAt: stamp,
          });
        }
        notes.commit({ FieldValue, actor });
      },
    };
  },
};
