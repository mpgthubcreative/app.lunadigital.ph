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
// (attendance / leave, advances) are counted for the "Waiting for you" box,
// and (Owner-pilot batch) grouped per helper: who needs attention, how
// many requests and of what type (attendance, leave, cash advance).
// Reads: a household has a handful of people, so per-person equality
// queries (no composite index) are fine.
// Owner-pilot simplification batch: "needs attention" per helper (only
// helpers with something): attendance corrections they reported, salary or
// advance not confirmed by them yet, a salary reported not received,
// deductions not taken, and any staff request still waiting.

// Owner-pilot polish (2026-10-16): each row also carries this cutoff's money
// for the Dashboard's one summary card (Employee filter on the screen):
//   salaryPaid    money actually paid for this cutoff (incl. additional payments)
//   prepaid       the part of salaryPaid that covered upcoming days (INSIDE it)
//   stillToPay    not paid yet: the payroll's take-home so far (the same
//                 figure as Payroll); paid: any additional salary due
//   advancesOutstanding   cash advances given and not repaid yet (plans don't
//                 lower it; salary overpayments aren't cash advances)
//   confirmation  this cutoff's salary: confirmed (with the date) / waiting / not received
// Voided payrolls / advances live in their own collections: never counted.

import { staffPeriod, onPayroll as isOnPayroll, daysIn, attendanceId, summarizeAttendance, advanceRemaining, plannedFor, scheduleOf, reconcileOf, paidTotal, advanceCapacity } from "../../../shared/payroll.js";
import { overpaymentLinesFor } from "./payroll.js";
import { businessDate, addDays } from "../../../shared/metrics.js";

const int = (v) => (Number.isSafeInteger(v) ? v : 0);

export async function householdSummary({ db, tenant, business, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  const staffSnap = await tenant.collection("householdStaff").where("status", "==", "active").get();
  const [pendingReq, requestedAdv, openCorr] = await Promise.all([
    tenant.collection("attendanceRequests").where("state", "==", "pending").get(),
    tenant.collection("advances").where("status", "==", "requested").get(),
    tenant.collection("attendanceCorrections").where("state", "==", "open").get(),
  ]);
  const recent = (day) => Boolean(day) && day >= addDays(today, -31);
  const attention = new Map();
  const bump = (staffId, name, kind, n = 1) => {
    if (!n) return;
    if (!attention.has(staffId)) attention.set(staffId, { staffId, name: name || "Staff", items: {}, total: 0 });
    const g = attention.get(staffId);
    g.items[kind] = (g.items[kind] || 0) + n;
    g.total += n;
  };
  // Owner-pilot batch: only people on payroll for their current period
  // (status, start / end dates), the same rule as the Payroll page.
  const onPayroll = new Set(staffSnap.docs.filter((d) => isOnPayroll(d.data(), staffPeriod(d.data(), today))).map((d) => d.id));
  const rows = await Promise.all(
    staffSnap.docs.map(async (d) => {
      const s = d.data();
      const period = staffPeriod(s, today);
      const days = daysIn(period).filter((x) => x <= today);
      // Owner-pilot polish: the period just before this one, if it was never
      // saved (worked out automatically) and nobody paid it yet.
      const prev = staffPeriod(s, addDays(period.start, -1));
      const prevOn = isOnPayroll(s, prev);
      const [paySnap, advSnap, lineSnaps, prevSnaps] = await Promise.all([
        tenant.collection("payrolls").where("staffId", "==", d.id).get(),
        tenant.collection("advances").where("staffId", "==", d.id).get(),
        days.length ? db.getAll(...days.map((x) => tenant.doc("attendance", attendanceId(d.id, x)))) : [],
        prevOn ? db.getAll(...daysIn(prev).map((x) => tenant.doc("attendance", attendanceId(d.id, x)))) : [],
      ]);
      const payrolls = paySnap.docs.map((p) => ({ id: p.id, ...p.data() }));
      const current = payrolls.find((p) => p.periodStart === period.start) || null;
      const overdue = payrolls.filter((p) => p.status === "draft" && p.periodEnd < period.start);
      const lastPaid = payrolls.filter((p) => p.status === "released").sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1))[0] || null;
      const advances = advSnap.docs.map((a) => ({ id: a.id, ...a.data() }));
      const released = advances.filter((a) => a.status === "paid" && advanceRemaining(a) > 0);
      // What the repayment plans take from this period (the stored payroll
      // if there is one); a paid salary deducts nothing more.
      const advance = current?.status === "draft" ? (current.deductions || []).filter((x) => x.type === "advance").reduce((t, x) => t + x.amount, 0) : current ? 0 : released.reduce((t, a) => t + plannedFor(a, period.start), 0);
      if (lastPaid && lastPaid.receiptStatus !== "confirmed" && lastPaid.dispute?.state !== "open" && recent(lastPaid.salary?.paidDate)) bump(d.id, s.name, "salaryConfirmation");
      bump(d.id, s.name, "salaryIssue", payrolls.filter((p) => p.dispute?.state === "open").length);
      bump(d.id, s.name, "advanceConfirmation", advances.filter((a) => a.status === "paid" && a.receipt?.state === "awaiting" && recent(a.paidDate)).length);
      bump(d.id, s.name, "notTaken", released.filter((a) => scheduleOf(a).some((e) => e.state === "not_taken")).length);
      bump(d.id, s.name, "additionalDue", payrolls.filter((p) => reconcileOf(p, today)?.additionalDue > 0).length);
      bump(d.id, s.name, "unrecordedDays", payrolls.filter((p) => reconcileOf(p, today)?.waiting).length);
      const sum = summarizeAttendance(lineSnaps.filter((x) => x.exists).map((x) => x.data()), { start: period.start, end: days.at(-1) ?? period.start });
      const carried = current ? 0 : overpaymentLinesFor(period.start, s, payrolls, today).reduce((t, l) => t + l.amount, 0);
      const prevBasic = prevOn && !payrolls.some((p) => p.periodStart === prev.start) ? summarizeAttendance(prevSnaps.filter((x) => x.exists).map((x) => x.data()), prev).basePay : 0;
      const prevNet = prevBasic ? prevBasic - released.reduce((t, a) => t + plannedFor(a, prev.start), 0) - overpaymentLinesFor(prev.start, s, payrolls, today).reduce((t, l) => t + l.amount, 0) : 0;
      const estimatedNet = current ? int(current.netPay) : sum.basePay - advance - carried;
      const paidNow = current?.status === "released";
      const rec = paidNow ? reconcileOf(current, today) : null;
      const confirmation = paidNow ? (current.receiptStatus === "confirmed" ? { state: "confirmed", at: current.receiptConfirmedAt?.toDate?.()?.toISOString?.() ?? null } : current.dispute?.state === "open" ? { state: "not_received" } : { state: "waiting" }) : null;
      const cap = advanceCapacity(s, advances);
      if (!onPayroll.has(d.id)) return null;
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
        overdue: [
          ...overdue.map((p) => ({ payrollId: p.id, period: { start: p.periodStart, end: p.periodEnd }, netPay: int(p.netPay) })),
          ...(prevNet > 0 ? [{ payrollId: null, period: { start: prev.start, end: prev.end }, netPay: prevNet, automatic: true }] : []),
        ],
        lastSalary: lastPaid ? { payrollId: lastPaid.id, period: { start: lastPaid.periodStart, end: lastPaid.periodEnd }, netPay: int(lastPaid.salary?.amount ?? lastPaid.netPay), receipt: lastPaid.receiptStatus === "confirmed" ? "received" : lastPaid.dispute?.state === "open" ? "not_received" : "waiting" } : null,
        hasLogin: Boolean(s.memberUid),
        money: {
          salaryPaid: paidNow ? paidTotal(current) : 0,
          prepaid: paidNow ? int(current.salary?.prepaid?.amount) : 0,
          prepaidRange: paidNow && current.salary?.prepaid ? { from: current.salary.prepaid.from, to: current.salary.prepaid.to } : null,
          paidDate: paidNow ? current.salary?.paidDate ?? null : null,
          stillToPay: paidNow ? int(rec?.additionalDue) : Math.max(0, estimatedNet),
          advancesOutstanding: advances.filter((a) => a.status === "paid").reduce((t, a) => t + advanceRemaining(a), 0),
          advanceAvailable: cap.available ?? null,
        },
        confirmation,
      };
    })
  );
  const listed = rows.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  for (const d of openCorr.docs) bump(d.data().staffId, d.data().staffName, "correction");
  for (const d of pendingReq.docs) bump(d.data().staffId, d.data().staffName, "attendanceRequest");
  for (const d of requestedAdv.docs) bump(d.data().staffId, d.data().staffName, "advanceRequest");
  const toPay = listed.filter((r) => r.payment === "not_paid");
  return {
    today,
    totalToPay: toPay.reduce((t, r) => t + Math.max(0, r.estimatedNet), 0),
    nextCutoff: toPay.length ? toPay.map((r) => r.period.end).sort()[0] : null,
    overdueTotal: listed.reduce((t, r) => t + r.overdue.reduce((x, o) => x + o.netPay, 0), 0),
    pending: { attendance: pendingReq.size, advances: requestedAdv.size, byStaff: [...attention.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)) },
    staff: listed,
  };
}
