// Household Dashboard (Phase 18.6), server side: "How much salary do I pay
// at the next cutoff, and is everyone's last salary sorted?"
//
// For each ACTIVE staff member, their current pay period (their own pay
// cycle, business-local today):
//   estimated net   the prepared (draft) payroll's net if there is one;
//                   otherwise basic pay from the days marked so far, minus
//                   the next deduction of each released advance (an
//                   estimate: it changes as days are marked)
//   advance to deduct  that next deduction
//   payment         this cutoff: Not paid yet / Paid; plus overdue ended
//                   periods still not paid
//   last salary     the latest paid salary's employee confirmation:
//                   Received / Waiting for confirmation / Reported not received
// Total to pay = sum of the estimated nets. Pending staff requests
// (attendance / leave, advances) are counted for the "Waiting for you" box.
// Reads: a household has a handful of people, so per-person equality
// queries (no composite index) are fine.

import { periodFor, daysIn, attendanceId, summarizeAttendance, advanceRemaining, nextDeduction } from "../../../shared/payroll.js";
import { businessDate } from "../../../shared/metrics.js";

const int = (v) => (Number.isSafeInteger(v) ? v : 0);

export async function householdSummary({ db, tenant, business, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  const staffSnap = await tenant.collection("householdStaff").where("status", "==", "active").get();
  const [pendingReq, requestedAdv] = await Promise.all([
    tenant.collection("attendanceRequests").where("state", "==", "pending").get(),
    tenant.collection("advances").where("status", "==", "requested").get(),
  ]);
  const rows = await Promise.all(
    staffSnap.docs.map(async (d) => {
      const s = d.data();
      const period = periodFor(s.payCycle, today);
      const days = daysIn(period).filter((x) => x <= today);
      const [paySnap, advSnap, lineSnaps] = await Promise.all([
        tenant.collection("payrolls").where("staffId", "==", d.id).get(),
        tenant.collection("advances").where("staffId", "==", d.id).get(),
        days.length ? db.getAll(...days.map((x) => tenant.doc("attendance", attendanceId(d.id, x)))) : [],
      ]);
      const payrolls = paySnap.docs.map((p) => ({ id: p.id, ...p.data() }));
      const current = payrolls.find((p) => p.periodStart === period.start) || null;
      const overdue = payrolls.filter((p) => p.status === "draft" && p.periodEnd < period.start);
      const lastPaid = payrolls.filter((p) => p.status === "released").sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1))[0] || null;
      const released = advSnap.docs.map((a) => a.data()).filter((a) => a.status === "paid" && !a.deducted && advanceRemaining(a) > 0);
      const advance = current?.status === "draft" ? (current.deductions || []).filter((x) => x.type === "advance").reduce((t, x) => t + x.amount, 0) : released.reduce((t, a) => t + nextDeduction(a), 0);
      const sum = summarizeAttendance(lineSnaps.filter((x) => x.exists).map((x) => x.data()), { start: period.start, end: days.at(-1) ?? period.start });
      const estimatedNet = current ? int(current.netPay) : sum.basePay - advance;
      return {
        staffId: d.id,
        name: s.name,
        position: s.position ?? null,
        period: { start: period.start, end: period.end },
        payrollId: current?.id ?? null,
        prepared: Boolean(current),
        estimatedNet,
        advanceToDeduct: advance,
        payment: current?.status === "released" ? (current.ownerPayment === "disputed" ? "disputed" : "paid") : "not_paid",
        overdue: overdue.map((p) => ({ payrollId: p.id, period: { start: p.periodStart, end: p.periodEnd }, netPay: int(p.netPay) })),
        lastSalary: lastPaid ? { payrollId: lastPaid.id, period: { start: lastPaid.periodStart, end: lastPaid.periodEnd }, netPay: int(lastPaid.salary?.amount ?? lastPaid.netPay), receipt: lastPaid.receiptStatus === "confirmed" ? "received" : lastPaid.dispute?.state === "open" ? "not_received" : "waiting" } : null,
        hasLogin: Boolean(s.memberUid),
      };
    })
  );
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const toPay = rows.filter((r) => r.payment === "not_paid");
  return {
    today,
    totalToPay: toPay.reduce((t, r) => t + Math.max(0, r.estimatedNet), 0),
    nextCutoff: toPay.length ? toPay.map((r) => r.period.end).sort()[0] : null,
    overdueTotal: rows.reduce((t, r) => t + r.overdue.reduce((x, o) => x + o.netPay, 0), 0),
    pending: { attendance: pendingReq.size, advances: requestedAdv.size },
    staff: rows,
  };
}
