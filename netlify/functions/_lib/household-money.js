// Luna Household: one month of household money, computed from the stored
// records (nothing new is stored, nothing is counted twice):
//   spent (expenses)   spendingMetrics/{YYYY-MM} (the Expenses Core keeps it)
//   staff paid         payroll: salaries RELEASED with a paid date in the
//                      month (payrolls/*.salary). Payroll stays the source of
//                      truth: no expense record is created for a salary.
//   bills remaining    Bills (scheduledPayments) still Upcoming and due by
//                      the month's end: their unpaid part
//   payroll            the month's released salaries as read-only rows
//                      (the Expenses list shows them under Household Staff)
// No budget: Luna Household is expense monitoring, not budgeting (owner
// pilot, 2026-10-17). Old budgets/current data stays stored, unused here.
// Cash advances aren't household spending (they're repaid through payroll),
// but they are cash that left the household:
//   advances released  advances RELEASED in the month (advances status
//                      "paid" = released, by paidDate; voided ones are moved
//                      out of the collection)
//   cash out           spent + advances released
// A later payroll deduction lowers the salary paid (salary.amount is what
// was actually paid), so the repayment is never negative spending and the
// advance is never counted twice.
// "Household Staff" in the breakdown = that expense category (if any) plus
// the salaries paid, so payroll shows once.

import { upcomingPart, amountOn, scheduleKind, recurrencePeriod, chainDueDates } from "../../../shared/baby.js";
import { businessDate } from "../../../shared/metrics.js";

const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthEnd = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}`;
};

export async function householdMonth({ db, tenant, business, uid = null, month = null, now = new Date() }) {
  const today = businessDate(business.timezone || "Asia/Manila", now);
  const m = month ?? today.slice(0, 7);
  if (!MONTH.test(m)) throw Object.assign(new Error("Choose a month like 2026-10"), { code: "invalid-input" });
  const start = `${m}-01`;
  const end = monthEnd(m);
  const [metric, cats, payrolls, bills, advances] = await Promise.all([
    tenant.doc("spendingMetrics", m).get(),
    tenant.collection("expenseCategories").limit(200).get(),
    tenant.collection("payrolls").where("status", "==", "released").limit(1000).get(),
    tenant.collection("scheduledPayments").limit(3000).get(),
    tenant.collection("advances").where("status", "==", "paid").limit(1000).get(),
  ]);
  let advancesReleased = 0;
  let advanceCount = 0;
  for (const a of advances.docs.map((d) => d.data())) {
    if (typeof a.paidDate === "string" && a.paidDate >= start && a.paidDate <= end) {
      advancesReleased += int(a.amount);
      advanceCount += 1;
    }
  }
  const names = Object.fromEntries(cats.docs.map((d) => [d.id, d.data().name]));
  const mt = metric.exists ? metric.data() : {};
  const spent = int(mt.spent);
  const byCategory = mt.byCategory && typeof mt.byCategory === "object" ? mt.byCategory : {};
  let staffPaid = 0;
  let staffCount = 0;
  const payroll = [];
  for (const d of payrolls.docs) {
    const p = d.data();
    const paidDate = p.salary?.paidDate;
    if (typeof paidDate === "string" && paidDate >= start && paidDate <= end) {
      staffPaid += int(p.salary?.amount);
      staffCount += 1;
      payroll.push({ id: d.id, staffName: p.staffName ?? null, amount: int(p.salary?.amount), paidDate });
    }
  }
  // The month's bills and scheduled expenses (Luna Household):
  //   every unpaid occurrence of a bill due in the month, plus any from an
  //     earlier month whose due date has PASSED: it carries forward
  //     ("Overdue from Oct", listed first) into every later month until
  //     it's paid; each occurrence separate, never merged
  //   a recurring bill's occurrences not stored yet (the next one is stored
  //     when the previous is paid, or on demand when paid from the list):
  //     projected from the bill's own due dates, at the amount in force; an
  //     unpaid earlier one doesn't stop later ones; already-past ones carry
  //     forward too (they're really due)
  //   one occurrence per bill per period (month / year / week): a period the
  //     bill already has (paid, unpaid or removed) is never projected
  //   scheduled one-time expenses planned in this month (kind "scheduled"):
  //     listed, never in Bills remaining, Spent only once paid
  const monthBills = [];
  const all = bills.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => typeof x.dueDate === "string");
  const chainOf = (x) => x.recurringId ?? x.id;
  const chains = new Map();
  for (const x of all) if (x.repeat && scheduleKind(x) !== "scheduled") chains.set(chainOf(x), [...(chains.get(chainOf(x)) || []), x]);
  const baseOf = (x) => ({ scheduleId: x.id, description: x.description, category: x.category, categoryName: x.categoryName ?? null, payee: x.payee ?? null, repeat: x.repeat ?? null, changesByPeriod: Array.isArray(x.amountSchedule) && x.amountSchedule.length > 1 });
  const carry = (due) => (due < start ? { overdue: true, overdueFrom: due.slice(0, 7) } : due < today ? { overdue: true } : {});
  const listed = new Set();
  for (const x of all) {
    if (x.status !== "upcoming") continue;
    if (scheduleKind(x) === "scheduled") {
      if (x.dueDate >= start && x.dueDate <= end) monthBills.push({ ...baseOf(x), id: x.id, kind: "scheduled", amount: upcomingPart(x), dueDate: x.dueDate, projected: false });
      continue;
    }
    const key = `${chainOf(x)}|${recurrencePeriod(x.dueDate, x.repeat)}`;
    // In this month, or an earlier one whose due date has passed (carried).
    const inView = (x.dueDate >= start && x.dueDate <= end) || (x.dueDate < start && x.dueDate < today);
    if (inView && upcomingPart(x) > 0 && !listed.has(key)) {
      listed.add(key);
      monthBills.push({ ...baseOf(x), id: x.id, kind: "bill", amount: upcomingPart(x), dueDate: x.dueDate, projected: false, ...carry(x.dueDate) });
    }
  }
  for (const [rid, xs] of chains) {
    const live = xs.filter((x) => x.status === "upcoming");
    if (!live.length) continue; // removed (or a one-time bill): nothing to project
    const ref = live.reduce((p, q) => (q.dueDate > p.dueDate ? q : p));
    const taken = new Set(xs.map((x) => recurrencePeriod(x.dueDate, ref.repeat)));
    const first = xs.map((x) => x.dueDate).sort()[0];
    for (const due of chainDueDates(first, ref.repeat, ref.repeatDay ?? null, end)) {
      const period = recurrencePeriod(due, ref.repeat);
      if (taken.has(period) || listed.has(`${rid}|${period}`)) continue;
      // In this month, or an earlier one whose due date has passed (carried).
      if (!(due >= start || due < today)) continue;
      listed.add(`${rid}|${period}`);
      monthBills.push({ ...baseOf(ref), id: `${ref.id}@${due}`, kind: "bill", amount: amountOn(ref.amountSchedule, due) ?? ref.amount, dueDate: due, projected: true, ...carry(due) });
    }
  }
  const dueBills = monthBills.filter((b) => b.kind === "bill");
  const billsRemaining = dueBills.reduce((t, b) => t + b.amount, 0);
  // Breakdown: expense categories + payroll under "Household Staff".
  const rows = new Map();
  for (const [id, amount] of Object.entries(byCategory)) {
    if (!int(amount)) continue;
    const name = names[id] ?? "Other";
    rows.set(name, (rows.get(name) || 0) + int(amount));
  }
  if (staffPaid) rows.set("Household Staff", (rows.get("Household Staff") || 0) + staffPaid);
  const categories = [...rows.entries()].map(([name, amount]) => ({ name, amount, ...(name === "Household Staff" && staffPaid ? { payroll: staffPaid } : {}) })).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  const spentTotal = spent + staffPaid;
  return {
    month: m,
    current: m === today.slice(0, 7),
    spent: spentTotal,
    expensesSpent: spent,
    staffPaid,
    staffPayments: staffCount,
    billsRemaining,
    billsDue: dueBills.length,
    bills: monthBills.sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    payroll: payroll.sort((a, b) => (a.paidDate < b.paidDate ? 1 : a.paidDate > b.paidDate ? -1 : 0)),
    advancesReleased,
    advanceCount,
    cashOut: spentTotal + advancesReleased,
    categories,
    // Expenses only, by category id.
    byCategory: Object.fromEntries(Object.entries(byCategory).filter(([, a]) => int(a))),
  };
}
