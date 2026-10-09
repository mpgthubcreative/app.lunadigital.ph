// Baby spending sink (Phase 15): what a Baby Expense counts as. Called by
// the Expenses Core (./expenses.js) inside the expense's transaction:
// prepare() does every read, commit() every write.
//
//   budgets/current          spent, expenseCount, spentByCategory: the
//                            active Baby Expenses (Remaining = total - spent
//                            is computed on read, never stored)
//   spendingMetrics/{day}    spent, count, byCategory for the Dashboard's
//   spendingMetrics/{month}  selected period (every write fills both
//                            counters, so a document that exists is real)
//   expenseCategories/{id}   useCount +1 when an expense starts using it
//                            (a used category can't be deleted)
//
// Reads: the budget document (threshold alerts; it also serializes a
// household's spending writes), the category an expense moves INTO (must be
// active), the provider it's newly linked to (must be active; its name is
// snapshotted as the payee), and, for an expense recorded from the Payment
// Schedule, that scheduled payment:
//   edit amount  -> the payment's paidAmount follows
//   remove       -> the payment goes back to Upcoming (counted in Upcoming
//                   again); marking it Paid later records a NEW expense
// Notifications: a 75 / 90 / 100% budget threshold crossed upward by this
// write, once per level per budget episode (Notifications Core).

import { ExpenseError } from "../../../shared/expenses.js";
import { BABY_SCHEMA_VERSION, BUDGET_DOC_ID, thresholdLevel } from "../../../shared/baby.js";
import { prepareNotifications } from "./notifications.js";

const MAX_HISTORY = 200;
const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const peso = (c) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const budgetRef = (tenant) => tenant.doc("budgets", BUDGET_DOC_ID);

function appendHistory(list, entry) {
  const l = Array.isArray(list) ? list : [];
  if (l.length >= MAX_HISTORY) throw new ExpenseError("history-full", "Too many changes on this record");
  return [...l, entry];
}

// Threshold alert planning shared by expenses and the budget itself.
// alerts = { episode, notified } on budgets/current.
export function alertsAfter(budget, spentAfter, { notify = true } = {}) {
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
      title: level >= 100 ? "Baby budget fully used" : `Baby budget ${level}% used`,
      message: `${peso(spentAfter)} of your ${peso(total)} budget has been spent.`,
      recordType: "budget",
      recordId: BUDGET_DOC_ID,
    },
  };
}

// Adds `amount` for `key` to a { key: delta } map.
const bump = (map, key, amount) => {
  if (key && amount) map[key] = (map[key] || 0) + amount;
};

export const babySpendingSink = {
  categoryLabel: (e) => e.categoryName ?? "Uncategorized",

  // upcomingDelta: { amount, count, category } a Payment Schedule change made
  // in the same transaction, folded into the ONE budgets/current write.
  async prepare(tx, { tenant, before, after, actor, upcomingDelta: extraUpcoming = null }) {
    // A scheduled payment being paid may still use the category / provider
    // it was scheduled with, even if deactivated since; new expenses can't.
    const fromSchedule = !before && Boolean(after?.scheduleId);
    const usable = (snap) => snap.exists && (snap.data().status === "active" || fromSchedule);
    const intoCategory = after && (!before || after.category !== before.category) ? after.category : null;
    const intoProvider = after && after.providerId && (!before || after.providerId !== before.providerId) ? after.providerId : null;
    const scheduleId = before?.scheduleId ?? null;
    const catRef = intoCategory ? tenant.doc("expenseCategories", intoCategory) : null;
    const provRef = intoProvider ? tenant.doc("providers", intoProvider) : null;
    const schedRef = scheduleId ? tenant.doc("scheduledPayments", scheduleId) : null;
    const [budgetSnap, catSnap, provSnap, schedSnap] = await Promise.all([tx.get(budgetRef(tenant)), catRef && tx.get(catRef), provRef && tx.get(provRef), schedRef && tx.get(schedRef)]);

    const fields = {};
    if (catRef) {
      if (!usable(catSnap)) throw new ExpenseError("invalid-category", "Choose an active category");
      fields.categoryName = catSnap.data().name;
    }
    if (after && after.providerId) {
      // A linked provider supplies the payee (a snapshot of its name).
      if (provRef) {
        if (!usable(provSnap)) throw new ExpenseError("invalid-provider", "Choose an active provider");
        fields.payee = provSnap.data().name;
      } else if (before && after.payee !== before.payee) throw new ExpenseError("invalid-input", "This expense is linked to a saved provider: change the provider instead of the payee");
    }

    // Deltas: the old contribution out, the new one in.
    const spentBy = {};
    const days = {}; // day -> { spent, count, byCategory }
    const day = (d) => (days[d] = days[d] || { spent: 0, count: 0, byCategory: {} });
    if (before) {
      bump(spentBy, before.category, -before.amount);
      const b = day(before.date);
      b.spent -= before.amount;
      b.count -= 1;
      bump(b.byCategory, before.category, -before.amount);
    }
    if (after) {
      bump(spentBy, after.category, after.amount);
      const a = day(after.date);
      a.spent += after.amount;
      a.count += 1;
      bump(a.byCategory, after.category, after.amount);
    }
    const dSpent = (after?.amount ?? 0) - (before?.amount ?? 0);
    const dCount = (after ? 1 : 0) - (before ? 1 : 0);

    const budget = budgetSnap.exists ? budgetSnap.data() : null;
    const spentAfter = int(budget?.spent) + dSpent;
    const { alerts, event } = alertsAfter(budget, spentAfter, { notify: dSpent > 0 });
    const notes = await prepareNotifications(tx, { tenant, actor, events: event ? [event] : [] });

    // The scheduled payment this expense came from.
    const sched = schedSnap && schedSnap.exists ? schedSnap.data() : null;
    const linked = sched && sched.status === "paid" && sched.expenseId === before.id;
    const reopen = linked && !after;
    // Upcoming changes: the caller's (a payment marked Paid leaves Upcoming)
    // and a reopened payment's (back into Upcoming).
    const up = { amount: 0, count: 0, byCategory: {} };
    const addUp = (amount, count, category) => {
      up.amount += amount;
      up.count += count;
      bump(up.byCategory, category, amount);
    };
    if (extraUpcoming) addUp(extraUpcoming.amount, extraUpcoming.count, extraUpcoming.category);
    if (reopen) addUp(sched.amount, 1, sched.category);

    return {
      fields,
      result: reopen ? { scheduleReopened: scheduleId } : undefined,
      commit({ FieldValue }) {
        const inc = (n) => FieldValue.increment(n);
        const stamp = FieldValue.serverTimestamp();
        const byCat = Object.fromEntries(Object.entries(spentBy).filter(([, v]) => v).map(([k, v]) => [k, inc(v)]));
        tx.set(
          budgetRef(tenant),
          {
            schemaVersion: BABY_SCHEMA_VERSION,
            spent: inc(dSpent),
            expenseCount: inc(dCount),
            spentByCategory: byCat,
            ...(up.amount || up.count ? { upcoming: inc(up.amount), upcomingCount: inc(up.count), upcomingByCategory: Object.fromEntries(Object.entries(up.byCategory).filter(([, v]) => v).map(([k, v]) => [k, inc(v)])) } : {}),
            alerts,
            updatedAt: stamp,
          },
          { merge: true }
        );
        for (const [d, v] of Object.entries(days)) {
          if (!v.spent && !v.count) continue;
          const body = { spent: inc(v.spent), count: inc(v.count), byCategory: Object.fromEntries(Object.entries(v.byCategory).filter(([, x]) => x).map(([k, x]) => [k, inc(x)])), updatedAt: stamp };
          tx.set(tenant.doc("spendingMetrics", d), { schemaVersion: BABY_SCHEMA_VERSION, period: "day", id: d, ...body }, { merge: true });
          tx.set(tenant.doc("spendingMetrics", d.slice(0, 7)), { schemaVersion: BABY_SCHEMA_VERSION, period: "month", id: d.slice(0, 7), ...body }, { merge: true });
        }
        if (catRef) tx.update(catRef, { useCount: inc(1) });
        if (linked && after && after.amount !== before.amount) {
          tx.update(schedRef, { paidAmount: after.amount, history: appendHistory(sched.history, { at: new Date(), actor, label: `Paid amount changed ${peso(before.amount)} → ${peso(after.amount)} (expense edited)` }), revision: int(sched.revision) + 1, updatedBy: actor, updatedAt: stamp });
        }
        if (reopen) {
          tx.update(schedRef, {
            status: "upcoming",
            expenseId: null,
            paidDate: null,
            paidAmount: null,
            method: null,
            reference: null,
            attempt: int(sched.attempt) + 1,
            history: appendHistory(sched.history, { at: new Date(), actor, label: "Its expense was removed: back to Upcoming" }),
            revision: int(sched.revision) + 1,
            updatedBy: actor,
            updatedAt: stamp,
          });
        }
        notes.commit({ FieldValue, actor });
      },
    };
  },
};
