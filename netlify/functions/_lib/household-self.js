// Household staff self-service (Phase 18.6), server side: what a kasambahay
// sees and does from their own account.
//
// Everything is scoped to the ONE householdStaff record linked to their
// membership (member.staffId, server-set when the Owner created the login).
// The staff member has no Firestore read access to household data; this
// module returns their own view only: their attendance this pay period,
// their requests, their salaries and their advances. Never another
// person's record, never the Owner's private notes.

import { PayrollError, periodFor, daysIn, attendanceId, summarizeAttendance, isValidStaffId, advanceRemaining, nextDeduction, ATTENDANCE_STATUSES, ADVANCE_STATUSES, SALARY_METHODS, payrollId as payrollIdOf } from "../../../shared/payroll.js";
import { businessDate } from "../../../shared/metrics.js";
import { prepareNotifications } from "./notifications.js";

const TX_OPTIONS = { maxAttempts: 10 };
const MAX_HISTORY = 200;
const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const peso = (c) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const iso = (v) => {
  const d = v instanceof Date ? v : typeof v?.toDate === "function" ? v.toDate() : null;
  return d ? d.toISOString() : null;
};
const append = (list, e) => {
  const l = Array.isArray(list) ? list : [];
  if (l.length >= MAX_HISTORY) throw new PayrollError("history-full", "Too many changes on this record");
  return [...l, e];
};

function linked(staffId) {
  if (!isValidStaffId(staffId)) throw new PayrollError("not-linked", "Your account isn't linked to a staff record. Ask your employer.");
  return staffId;
}

// A salary as the employee sees it.
const salaryView = (p) => ({
  id: p.id,
  period: { start: p.periodStart, end: p.periodEnd },
  state: p.status === "released" ? "paid" : "preparing",
  days: { present: int(p.present), paidLeave: int(p.officialLeave), unpaidLeave: int(p.unpaidLeave), absent: int(p.absent), restDay: int(p.restDay) },
  basicPay: int(p.basePay),
  additions: (p.additions || []).map((a) => ({ type: a.type, description: a.description, amount: a.amount })),
  deductions: (p.deductions || []).map((d) => ({ type: d.type, description: d.description, amount: d.amount })),
  grossPay: Number.isSafeInteger(p.grossPay) ? p.grossPay : int(p.basePay) + int(p.additionsTotal),
  netPay: int(p.salary?.amount ?? p.netPay),
  payment: p.status === "released" ? { method: SALARY_METHODS[p.salary?.method]?.label ?? null, paidDate: p.salary?.paidDate ?? null, hasProof: Boolean(p.salary?.proof) } : null,
  receipt: p.receiptStatus === "confirmed" ? "received" : p.dispute?.state === "open" ? "not_received" : p.status === "released" ? "not_confirmed" : null,
});

const advanceView = (a) => ({
  id: a.id,
  date: a.date,
  reason: a.description ?? null,
  requested: a.requestedAmount ?? null,
  amount: a.amount,
  status: a.status,
  statusLabel: ADVANCE_STATUSES[a.status]?.label ?? a.status,
  installment: a.installment ?? null,
  deducted: Math.max(0, a.amount - advanceRemaining(a)),
  remaining: a.status === "paid" ? advanceRemaining(a) : null,
  releasedOn: a.paidDate ?? null,
  answer: a.decision?.note ?? null,
});

export async function myHousehold({ db, tenant, business, staffId, now = new Date() }) {
  const id = linked(staffId);
  const staffSnap = await tenant.doc("householdStaff", id).get();
  if (!staffSnap.exists) throw new PayrollError("not-linked", "Your staff record wasn't found. Ask your employer.");
  const staff = staffSnap.data();
  const today = businessDate(business.timezone, now);
  const period = periodFor(staff.payCycle, today);
  const days = daysIn(period);
  // Single-field equality queries only (no composite index), sorted here.
  const [lineSnaps, reqSnap, paySnap, advSnap] = await Promise.all([
    db.getAll(...days.map((d) => tenant.doc("attendance", attendanceId(id, d)))),
    tenant.collection("attendanceRequests").where("staffId", "==", id).get(),
    tenant.collection("payrolls").where("staffId", "==", id).get(),
    tenant.collection("advances").where("staffId", "==", id).get(),
  ]);
  const lines = lineSnaps.filter((s) => s.exists).map((s) => s.data());
  const payrolls = paySnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));
  const advances = advSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const requests = reqSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.date < b.date ? 1 : -1));

  // This period, so far: the draft payroll if one is prepared, otherwise an
  // estimate from the days marked so far and the advance to deduct next.
  const draft = payrolls.find((p) => p.periodStart === period.start && p.status === "draft") || null;
  const sum = summarizeAttendance(lines, period);
  const toDeduct = advances.filter((a) => a.status === "paid" && !a.deducted && advanceRemaining(a) > 0).reduce((t, a) => t + nextDeduction(a), 0);
  const estimate = draft
    ? { basicPay: int(draft.basePay), additions: int(draft.additionsTotal), deductions: int(draft.deductionsTotal), netPay: int(draft.netPay), prepared: true }
    : { basicPay: sum.basePay, additions: 0, deductions: toDeduct, netPay: sum.basePay - toDeduct, prepared: false };

  return {
    staff: { name: staff.name, position: staff.position ?? null, dailyWage: staff.dailyWage, payCycle: staff.payCycle, startDate: staff.startDate ?? null },
    today,
    todayStatus: lines.find((l) => l.date === today)?.status ?? null,
    period: { start: period.start, end: period.end, days: days.map((d) => ({ date: d, status: lines.find((l) => l.date === d)?.status ?? null, pending: requests.find((r) => r.date === d && r.state === "pending")?.status ?? null })), counts: sum, estimate },
    requests: requests.slice(0, 20).map((r) => ({ id: r.id, date: r.date, status: r.status, statusLabel: ATTENDANCE_STATUSES[r.status]?.label ?? r.status, note: r.note ?? null, state: r.state, answer: r.decisionNote ?? null })),
    salaries: payrolls.slice(0, 8).map(salaryView),
    advances: advances.slice(0, 12).map(advanceView),
  };
}

async function ownPayroll(tx, tenant, staffId, payrollId) {
  const m = /^([A-Za-z0-9]{8,40})_(\d{4}-\d{2}-\d{2})$/.exec(typeof payrollId === "string" ? payrollId : "");
  // Only the person's own payroll: the id embeds the staff id, and the
  // stored record must agree.
  if (!m || m[1] !== staffId) throw new PayrollError("not-found", "Salary not found");
  const snap = await tx.get(tenant.doc("payrolls", payrollIdOf(m[1], m[2])));
  if (!snap.exists || snap.data().staffId !== staffId) throw new PayrollError("not-found", "Salary not found");
  return snap;
}

// "I received my salary". Independent of the Owner marking it paid: only a
// salary the Owner marked paid can be confirmed, and confirming never
// changes the payment itself. Also retires the one-time receipt link.
export async function confirmSalaryReceived({ db, tenant, FieldValue, staffId, payrollId, actor }) {
  const id = linked(staffId);
  return db.runTransaction(async (tx) => {
    const snap = await ownPayroll(tx, tenant, id, payrollId);
    const p = snap.data();
    if (p.status !== "released") throw new PayrollError("payment-not-paid", "Your employer hasn't marked this salary as paid yet");
    if (p.receiptStatus === "confirmed") return { payrollId, receipt: "received", alreadyConfirmed: true };
    const linkRef = p.receiptLinkHash ? db.collection("receiptLinks").doc(p.receiptLinkHash) : null;
    const linkSnap = linkRef ? await tx.get(linkRef) : null;
    const notes = await prepareNotifications(tx, {
      tenant,
      actor,
      events: [{ type: "payroll.receipt_confirmed", key: snap.id, title: "Salary receipt confirmed", message: `${p.staffName} confirmed receiving ${peso(p.salary?.amount ?? p.netPay)} for ${p.periodStart} to ${p.periodEnd}.`, recordType: "payroll", recordId: snap.id }],
    });
    const stamp = FieldValue.serverTimestamp();
    tx.update(snap.ref, {
      receiptStatus: "confirmed",
      receiptConfirmedAt: stamp,
      receiptConfirmedVia: "staff-account",
      receiptConfirmedBy: { uid: actor.uid, name: actor.name ?? null },
      ...(p.dispute?.state === "open" ? { dispute: { ...p.dispute, state: "resolved", resolvedAt: new Date(), resolution: "Employee confirmed receipt" }, ownerPayment: "paid" } : {}),
      history: append(p.history, { at: new Date(), actor: { uid: actor.uid, name: actor.name ?? null }, label: `${p.staffName} confirmed receipt (own account)` }),
      updatedAt: stamp,
    });
    if (linkSnap?.exists && !linkSnap.data().usedAt) tx.update(linkRef, { usedAt: stamp });
    notes.commit({ FieldValue, actor });
    return { payrollId, receipt: "received" };
  }, TX_OPTIONS);
}

// "I didn't receive this". The salary stays marked paid (that's the
// Owner's record); it's flagged Payment disputed until it's sorted out.
export async function reportSalaryNotReceived({ db, tenant, FieldValue, staffId, payrollId, note = null, actor }) {
  const id = linked(staffId);
  const why = typeof note === "string" ? note.trim().replace(/\s+/g, " ").slice(0, 200) : "";
  return db.runTransaction(async (tx) => {
    const snap = await ownPayroll(tx, tenant, id, payrollId);
    const p = snap.data();
    if (p.status !== "released") throw new PayrollError("payment-not-paid", "Your employer hasn't marked this salary as paid yet");
    if (p.receiptStatus === "confirmed") throw new PayrollError("receipt-confirmed", "You already confirmed receiving this salary");
    if (p.dispute?.state === "open") return { payrollId, receipt: "not_received", unchanged: true };
    const notes = await prepareNotifications(tx, {
      tenant,
      actor,
      events: [{ type: "payroll.salary_disputed", key: `${snap.id}-${(p.disputeCount || 0) + 1}`, title: `${p.staffName} says the salary didn't arrive`, message: `${peso(p.salary?.amount ?? p.netPay)} for ${p.periodStart} to ${p.periodEnd}${why ? ` · "${why}"` : ""}`, recordType: "payroll", recordId: snap.id }],
    });
    const stamp = FieldValue.serverTimestamp();
    tx.update(snap.ref, {
      ownerPayment: "disputed",
      dispute: { state: "open", note: why || null, at: new Date(), by: { uid: actor.uid, name: actor.name ?? null } },
      disputeCount: (p.disputeCount || 0) + 1,
      history: append(p.history, { at: new Date(), actor: { uid: actor.uid, name: actor.name ?? null }, label: `${p.staffName} reported the salary as not received${why ? ` · ${why}` : ""}` }),
      updatedAt: stamp,
    });
    notes.commit({ FieldValue, actor });
    return { payrollId, receipt: "not_received" };
  }, TX_OPTIONS);
}
