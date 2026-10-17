// Luna Household: one month of household money, computed from the stored
// records (nothing new is stored, nothing is counted twice):
//   spent (expenses)   spendingMetrics/{YYYY-MM} (the Expenses Core keeps it)
//   staff paid         payroll: salaries RELEASED with a paid date in the
//                      month (payrolls/*.salary). Payroll stays the source of
//                      truth: no expense record is created for a salary.
//   payroll due        this month only: the Household summary's salary still
//                      to pay at the next cutoff (+ overdue cutoffs)
//   bills remaining    Bills (scheduledPayments) still Upcoming and due by
//                      the month's end: their unpaid part
//   budget             budgets/current.total = the MONTHLY household budget
//   left               budget − spent − staff paid − bills remaining − payroll due
// Cash advances aren't household spending (they're repaid through payroll).
// "Household Staff" in the breakdown = that expense category (if any) plus
// the salaries paid, so payroll shows once.

import { BUDGET_DOC_ID, upcomingPart } from "../../../shared/baby.js";
import { businessDate } from "../../../shared/metrics.js";
import { householdSummary } from "./household-summary.js";

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
  const [metric, budget, cats, payrolls, bills] = await Promise.all([
    tenant.doc("spendingMetrics", m).get(),
    tenant.doc("budgets", BUDGET_DOC_ID).get(),
    tenant.collection("expenseCategories").limit(200).get(),
    tenant.collection("payrolls").where("status", "==", "released").limit(1000).get(),
    tenant.collection("scheduledPayments").where("status", "==", "upcoming").limit(500).get(),
  ]);
  const names = Object.fromEntries(cats.docs.map((d) => [d.id, d.data().name]));
  const mt = metric.exists ? metric.data() : {};
  const spent = int(mt.spent);
  const byCategory = mt.byCategory && typeof mt.byCategory === "object" ? mt.byCategory : {};
  let staffPaid = 0;
  let staffCount = 0;
  for (const p of payrolls.docs.map((d) => d.data())) {
    const paidDate = p.salary?.paidDate;
    if (typeof paidDate === "string" && paidDate >= start && paidDate <= end) {
      staffPaid += int(p.salary?.amount);
      staffCount += 1;
    }
  }
  const dueBills = bills.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => typeof s.dueDate === "string" && s.dueDate <= end && (m === today.slice(0, 7) || s.dueDate >= start));
  const billsRemaining = dueBills.reduce((t, s) => t + upcomingPart(s), 0);
  let payrollDue = 0;
  if (m === today.slice(0, 7)) {
    const s = await householdSummary({ db, tenant, business, uid, now });
    payrollDue = Math.max(0, int(s.totalToPay)) + Math.max(0, int(s.overdueTotal));
  }
  const total = budget.exists && Number.isSafeInteger(budget.data().total) ? budget.data().total : null;
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
    payrollDue,
    budget: total,
    left: total === null ? null : total - spentTotal - billsRemaining - payrollDue,
    categories,
    // Expenses only, by category id (the Budget & Categories screen).
    byCategory: Object.fromEntries(Object.entries(byCategory).filter(([, a]) => int(a))),
  };
}
