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

import { upcomingPart, nextDueDate, amountOn, scheduleKind } from "../../../shared/baby.js";
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
    tenant.collection("scheduledPayments").where("status", "==", "upcoming").limit(500).get(),
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
  // The month's bills and scheduled expenses (Luna Household, 2026-10-17):
  //   stored bills still to pay: due by the month's end (the current month
  //     also shows overdue ones from earlier months), their unpaid part
  //   projected occurrences of a recurring bill in this month (after its
  //     stored next one; never stored): the amount in force on that date
  //   scheduled one-time expenses planned in this month (kind "scheduled"):
  //     listed, never in Bills remaining, Spent only once paid
  const current = m === today.slice(0, 7);
  const monthBills = [];
  for (const d of bills.docs) {
    const s = { id: d.id, ...d.data() };
    if (typeof s.dueDate !== "string") continue;
    const base = { scheduleId: s.id, description: s.description, category: s.category, categoryName: s.categoryName ?? null, payee: s.payee ?? null, repeat: s.repeat ?? null, changesByPeriod: Array.isArray(s.amountSchedule) && s.amountSchedule.length > 1 };
    if (scheduleKind(s) === "scheduled") {
      if (s.dueDate >= start && s.dueDate <= end) monthBills.push({ ...base, id: s.id, kind: "scheduled", amount: upcomingPart(s), dueDate: s.dueDate, projected: false });
      continue;
    }
    if (s.dueDate <= end && (current || s.dueDate >= start) && upcomingPart(s) > 0) monthBills.push({ ...base, id: s.id, kind: "bill", amount: upcomingPart(s), dueDate: s.dueDate, projected: false });
    if (s.repeat) {
      let due = s.dueDate;
      for (let i = 0; i < 400; i++) {
        due = nextDueDate(due, s.repeat, s.repeatDay ?? null);
        if (due > end) break;
        if (due >= start) monthBills.push({ ...base, id: `${s.id}@${due}`, kind: "bill", amount: amountOn(s.amountSchedule, due) ?? s.amount, dueDate: due, projected: true });
      }
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
