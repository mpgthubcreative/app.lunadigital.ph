// Baby spending sink (Phase 15): what a Baby Expense counts as. Called by
// the Expenses Core (./expenses.js) inside the expense's transaction:
// prepare() does every read, commit() every write.
//
//   budgets/current          spent, expenseCount, spentByCategory: the
//                            active Baby Expenses (Remaining = total - spent
//                            is computed on read, never stored);
//                            spentByPayer + payerNames (Phase 18.6): each
//                            expense's Paid-by shares, so a shared purchase
//                            counts once in spent and is split by payer
//   spendingMetrics/{day}    spent, count, byCategory for the Dashboard's
//   spendingMetrics/{month}  selected period (every write fills both
//                            counters, so a document that exists is real)
//   expenseCategories/{id}   useCount +1 when an expense starts using it
//                            (a used category can't be deleted)
//
// Reads: the budget document (threshold alerts; it also serializes a
// household's spending writes), the category an expense moves INTO (must be
// active), the provider it's newly linked to (must be active; its name is
// snapshotted as providerName, and as the payee when none is given), and,
// for an expense recorded from the Payment Schedule, that scheduled payment.
// Phase 18.6: a scheduled payment can be paid in parts (each part is one
// expense, listed in its `parts`); Upcoming counts only its unpaid part
// (shared/baby.js upcomingPart):
//   edit amount  -> the part and the payment's paidAmount follow; an
//                   Upcoming payment's unpaid part moves with it
//   remove       -> the part leaves the payment; a Paid payment goes back to
//                   Upcoming (its unpaid part counts in Upcoming again);
//                   marking it Paid later records a NEW expense
// Notifications: a 75 / 90 / 100% budget threshold crossed upward by this
// write, once per level per budget episode (Notifications Core).

import { ExpenseError } from "../../../shared/expenses.js";
import { BABY_SCHEMA_VERSION, BUDGET_DOC_ID, thresholdLevel, upcomingPart } from "../../../shared/baby.js";
import { prepareNotifications } from "./notifications.js";

const MAX_HISTORY = 200;
const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const peso = (c) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const budgetRef = (tenant) => tenant.doc("budgets", BUDGET_DOC_ID);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

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

// The parts a scheduled payment has been paid with. A payment marked Paid
// before Phase 18.6 has no `parts`: its single expense is the whole part.
export function partsOf(s) {
  if (Array.isArray(s?.parts)) return s.parts;
  return s?.status === "paid" && s.expenseId ? [{ expenseId: s.expenseId, amount: int(s.paidAmount ?? s.amount), date: s.paidDate ?? null }] : [];
}

// Paid by after an edit: when only the amount changed and ONE person paid,
// their share follows the amount; otherwise the shares must add up.
function resolvePaidBy(before, after) {
  const list = after.paidBy ?? null;
  if (!list) return null;
  const sum = list.reduce((s, p) => s + p.amount, 0);
  if (sum === after.amount) return list;
  if (before && same(list, before.paidBy) && list.length === 1) return [{ ...list[0], amount: after.amount }];
  throw new ExpenseError("paid-by-mismatch", `The shares add up to ${peso(sum)}, not the expense amount ${peso(after.amount)}. Update who paid.`);
}

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
    // Provider = who supplies the product or service (a saved directory
    // entry); Payee = who received the money. They're separate: a linked
    // provider fills the payee only when none is given, or when the payee
    // was the previous provider's name.
    if (provRef) {
      if (!usable(provSnap)) throw new ExpenseError("invalid-provider", "Choose an active provider");
      const name = provSnap.data().name;
      fields.providerName = name;
      const autoPayee = before ? before.providerName ?? (before.providerId ? before.payee : null) : null;
      if (!after.payee || (before && autoPayee && after.payee === autoPayee)) fields.payee = name;
    } else if (after && !after.providerId && before?.providerId) {
      fields.providerName = null;
    }

    // Who paid (Phase 18.6).
    if (after) {
      const resolved = resolvePaidBy(before, after);
      if (!same(resolved, after.paidBy)) fields.paidBy = resolved;
    }
    const paidByAfter = after ? (fields.paidBy !== undefined ? fields.paidBy : after.paidBy ?? null) : null;

    // Deltas: the old contribution out, the new one in.
    const spentBy = {};
    const payerBy = {};
    const payerNames = {};
    const days = {}; // day -> { spent, count, byCategory }
    const day = (d) => (days[d] = days[d] || { spent: 0, count: 0, byCategory: {} });
    if (before) {
      bump(spentBy, before.category, -before.amount);
      for (const p of before.paidBy || []) bump(payerBy, p.key, -p.amount);
      const b = day(before.date);
      b.spent -= before.amount;
      b.count -= 1;
      bump(b.byCategory, before.category, -before.amount);
    }
    if (after) {
      bump(spentBy, after.category, after.amount);
      for (const p of paidByAfter || []) {
        bump(payerBy, p.key, p.amount);
        payerNames[p.key] = p.name;
      }
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

    // The scheduled payment this expense is a part of.
    const sched = schedSnap && schedSnap.exists ? schedSnap.data() : null;
    const parts = sched ? partsOf(sched) : [];
    const part = before ? parts.find((p) => p.expenseId === before.id) : null;
    let schedUpdate = null;
    let reopen = false;
    // Upcoming changes: the caller's (a payment being paid) and this
    // payment's unpaid part before / after.
    const up = { amount: 0, count: 0, byCategory: {} };
    const addUp = (amount, count, category) => {
      up.amount += amount;
      up.count += count;
      bump(up.byCategory, category, amount);
    };
    if (extraUpcoming) addUp(extraUpcoming.amount, extraUpcoming.count, extraUpcoming.category);
    if (part && (!after || after.amount !== before.amount)) {
      const nextParts = after ? parts.map((p) => (p.expenseId === before.id ? { ...p, amount: after.amount } : p)) : parts.filter((p) => p.expenseId !== before.id);
      const paidAmount = nextParts.reduce((s, p) => s + int(p.amount), 0);
      reopen = !after && sched.status === "paid";
      const next = { ...sched, parts: nextParts, paidAmount, status: reopen ? "upcoming" : sched.status };
      // upcomingCount = payments still Upcoming: only a reopen changes it.
      addUp(upcomingPart(next) - upcomingPart(sched), (next.status === "upcoming" ? 1 : 0) - (sched.status === "upcoming" ? 1 : 0), sched.category);
      const label = after ? `Paid amount changed ${peso(before.amount)} → ${peso(after.amount)} (expense edited)` : reopen ? "Its expense was removed: back to Upcoming" : `A part payment of ${peso(before.amount)} was removed (expense removed)`;
      schedUpdate = {
        parts: nextParts,
        paidAmount: nextParts.length ? paidAmount : null,
        ...(reopen
          ? { status: "upcoming", expenseId: null, paidDate: null, method: null, reference: null, attempt: int(sched.attempt) + 1 }
          : {}),
        history: appendHistory(sched.history, { at: new Date(), actor, label }),
        revision: int(sched.revision) + 1,
        updatedBy: actor,
      };
    }

    return {
      fields,
      result: reopen ? { scheduleReopened: scheduleId } : undefined,
      commit({ FieldValue }) {
        const inc = (n) => FieldValue.increment(n);
        const stamp = FieldValue.serverTimestamp();
        const incMap = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v).map(([k, v]) => [k, inc(v)]));
        tx.set(
          budgetRef(tenant),
          {
            schemaVersion: BABY_SCHEMA_VERSION,
            spent: inc(dSpent),
            expenseCount: inc(dCount),
            spentByCategory: incMap(spentBy),
            ...(Object.values(payerBy).some(Boolean) ? { spentByPayer: incMap(payerBy) } : {}),
            ...(Object.keys(payerNames).length ? { payerNames } : {}),
            ...(up.amount || up.count ? { upcoming: inc(up.amount), upcomingCount: inc(up.count), upcomingByCategory: incMap(up.byCategory) } : {}),
            alerts,
            updatedAt: stamp,
          },
          { merge: true }
        );
        for (const [d, v] of Object.entries(days)) {
          if (!v.spent && !v.count) continue;
          const body = { spent: inc(v.spent), count: inc(v.count), byCategory: incMap(v.byCategory), updatedAt: stamp };
          tx.set(tenant.doc("spendingMetrics", d), { schemaVersion: BABY_SCHEMA_VERSION, period: "day", id: d, ...body }, { merge: true });
          tx.set(tenant.doc("spendingMetrics", d.slice(0, 7)), { schemaVersion: BABY_SCHEMA_VERSION, period: "month", id: d.slice(0, 7), ...body }, { merge: true });
        }
        if (catRef) tx.update(catRef, { useCount: inc(1) });
        if (schedUpdate) tx.update(schedRef, { ...schedUpdate, updatedAt: stamp });
        notes.commit({ FieldValue });
      },
    };
  },
};
