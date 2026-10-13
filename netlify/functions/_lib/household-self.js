// Household staff self-service (Phase 18.6), server side: what a kasambahay
// sees and does from their own account.
//
// Everything is scoped to the ONE householdStaff record linked to their
// membership (member.staffId, server-set when the Owner created the login).
// The staff member has no Firestore read access to household data; this
// module returns their own view only: their attendance this pay period,
// their requests, their salaries and their advances. Never another
// person's record, never the Owner's private notes.

import { PayrollError, staffPeriod, paidPayrollLocks, advanceCapacity, cycleLabel, plannedEntries, scheduleOf, reconcileOf, paidTotal, daysIn, attendanceId, summarizeAttendance, isValidStaffId, advanceRemaining, nextDeduction, selfDayLock, MAX_DAYS_AHEAD, ATTENDANCE_STATUSES, ADVANCE_STATUSES, SALARY_METHODS, payrollId as payrollIdOf } from "../../../shared/payroll.js";
import { businessDate, addDays, isDayId } from "../../../shared/metrics.js";
import { prepareNotifications } from "./notifications.js";
import { readProofFile, dayRange, overpaymentLinesFor, paidLeaveOf } from "./payroll.js";

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
  payment: p.status === "released" ? { method: SALARY_METHODS[p.salary?.method]?.label ?? null, paidDate: p.salary?.paidDate ?? null, hasProof: Boolean(p.salary?.proof), early: p.paymentTiming === "early" } : null,
  // Owner-pilot refinement: what was given, in plain parts (earned so far +
  // prepaid upcoming days), and any later additional payment.
  received: p.status === "released" && p.salary ? { earned: int(p.salary.earned ?? p.salary.amount), prepaid: p.salary.prepaid ? { days: p.salary.prepaid.days, from: p.salary.prepaid.from, to: p.salary.prepaid.to, amount: p.salary.prepaid.amount } : null, additional: (p.salary.additional || []).map((a) => ({ amount: a.amount, paidDate: a.paidDate })), total: paidTotal(p) } : null,
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
  // Owner-pilot simplification batch: the plan the Owner set (read-only
  // here), the proof, and whether they confirmed receiving it.
  planned: a.status === "paid" && advanceRemaining(a) > 0 ? plannedEntries(a).map((e) => ({ periodStart: e.periodStart, periodEnd: e.periodEnd, amount: e.amount })) : [],
  hasProof: Boolean(a.proof),
  received: a.status === "paid" ? (a.receipt?.state === "confirmed" ? "confirmed" : "awaiting") : null,
});

// Owner-pilot polish: which pay periods the staff member can open on their
// attendance sheet. Back to the period of their start date (at most ~2
// months, older days are the employer's to fix anyway); forward while leave
// can still be planned and before their last day.
const SHEET_BACK_DAYS = 62;
function sheetBounds(staff, today) {
  const lo = [staff.startDate, addDays(today, -SHEET_BACK_DAYS)].filter(Boolean).sort().pop();
  const hi = [staff.endDate, addDays(today, MAX_DAYS_AHEAD)].filter(Boolean).sort()[0];
  return { lo, hi };
}

export async function myHousehold({ db, tenant, business, staffId, now = new Date(), periodStart = null }) {
  const id = linked(staffId);
  const staffSnap = await tenant.doc("householdStaff", id).get();
  if (!staffSnap.exists) throw new PayrollError("not-linked", "Your staff record wasn't found. Ask your employer.");
  const staff = staffSnap.data();
  const today = businessDate(business.timezone, now);
  const period = staffPeriod(staff, today);
  const days = daysIn(period);
  // The attendance sheet: this period, or another one they asked for.
  const bounds = sheetBounds(staff, today);
  let sheetPeriod = period;
  if (periodStart !== null) {
    if (!isDayId(periodStart) || staffPeriod(staff, periodStart).start !== periodStart) throw new PayrollError("invalid-date", "Invalid pay period");
    sheetPeriod = staffPeriod(staff, periodStart);
    if (sheetPeriod.end < bounds.lo || sheetPeriod.start > bounds.hi) throw new PayrollError("invalid-date", "That pay period isn't available");
  }
  const sheetDays = daysIn(sheetPeriod);
  // Single-field equality queries only (no composite index), sorted here.
  const [lineSnaps, reqSnap, paySnap, advSnap, confSnap, corrSnap, leave] = await Promise.all([
    db.getAll(...[...new Set([...days, ...sheetDays])].map((d) => tenant.doc("attendance", attendanceId(id, d)))),
    tenant.collection("attendanceRequests").where("staffId", "==", id).get(),
    tenant.collection("payrolls").where("staffId", "==", id).get(),
    tenant.collection("advances").where("staffId", "==", id).get(),
    tenant.doc("attendanceConfirmations", `${id}_${sheetPeriod.start}`).get(),
    tenant.collection("attendanceCorrections").where("staffId", "==", id).get(),
    // Owner-pilot cleanup: their Paid Leave this calendar year (view only).
    paidLeaveOf({ tenant, staffId: id, staff, year: Number(today.slice(0, 4)) }).catch(() => null),
  ]);
  const lines = lineSnaps.filter((s) => s.exists).map((s) => s.data());
  const payrolls = paySnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));
  const advances = advSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const requests = reqSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.date < b.date ? 1 : -1));

  // This period, so far: the draft payroll if one is prepared, otherwise an
  // estimate from the days marked so far and the advance to deduct next.
  const draft = payrolls.find((p) => p.periodStart === period.start && p.status === "draft") || null;
  const sum = summarizeAttendance(lines.filter((l) => l.date >= period.start && l.date <= period.end), period);
  const toDeduct = advances.filter((a) => a.status === "paid" && !a.deducted && advanceRemaining(a) > 0).reduce((t, a) => t + nextDeduction(a), 0);
  const estimate = draft
    ? { basicPay: int(draft.basePay), additions: int(draft.additionsTotal), deductions: int(draft.deductionsTotal), netPay: int(draft.netPay), prepared: true }
    : { basicPay: sum.basePay, additions: 0, deductions: toDeduct, netPay: sum.basePay - toDeduct, prepared: false };

  // Paid days are read-only; after an EARLY payment the days after the
  // payment date stay open until the period ends.
  const sheetPayroll = payrolls.find((p) => p.periodStart === sheetPeriod.start) || null;
  const sheetPaid = Boolean(sheetPayroll) && sheetPayroll.status !== "draft";
  const prevPeriod = staffPeriod(staff, addDays(sheetPeriod.start, -1));
  const nextPeriod = staffPeriod(staff, addDays(sheetPeriod.end, 1));
  const sheet = {
    start: sheetPeriod.start,
    end: sheetPeriod.end,
    current: sheetPeriod.start === period.start,
    prev: prevPeriod.end >= bounds.lo ? prevPeriod.start : null,
    next: nextPeriod.start <= bounds.hi ? nextPeriod.start : null,
    paid: sheetPaid,
    // Owner-pilot simplification batch: what's recorded, in totals, and
    // whether they confirmed it (changed since = confirm again).
    counts: summarizeAttendance(lines.filter((l) => l.date >= sheetPeriod.start && l.date <= sheetPeriod.end), sheetPeriod),
    confirmation: confSnap.exists ? { at: iso(confSnap.data().confirmedAt), current: JSON.stringify(confSnap.data().counts) === JSON.stringify((({ present, absent, officialLeave, unpaidLeave, restDay, notMarked }) => ({ present, absent, officialLeave, unpaidLeave, restDay, notMarked }))(summarizeAttendance(lines.filter((l) => l.date >= sheetPeriod.start && l.date <= sheetPeriod.end), sheetPeriod))) } : null,
    canConfirm: sheetPeriod.start <= today,
    days: sheetDays.map((d) => {
      const line = lines.find((l) => l.date === d);
      const latest = requests.find((r) => r.date === d);
      const pending = latest?.state === "pending" ? latest.status : null;
      return {
        date: d,
        status: line?.status ?? null,
        pending,
        rejected: latest?.state === "rejected" && !line ? latest.status : null,
        lock: selfDayLock({ staff, date: d, today, recorded: Boolean(line) && !pending, paid: paidPayrollLocks(sheetPayroll, d) }),
      };
    }),
  };

  return {
    sheet,
    staff: { name: staff.name, position: staff.position ?? null, dailyWage: staff.dailyWage, payCycle: staff.payCycle, payCycleLabel: cycleLabel(staff), startDate: staff.startDate ?? null, endDate: staff.endDate ?? null },
    // Owner-pilot batch: their cash advance limit (null limit = no limit set).
    advanceLimit: advanceCapacity(staff, advances),
    leave: leave ? { year: leave.year, entitled: leave.entitled, used: leave.used, remaining: leave.remaining } : null,
    today,
    todayStatus: lines.find((l) => l.date === today)?.status ?? null,
    period: { start: period.start, end: period.end, days: days.map((d) => ({ date: d, status: lines.find((l) => l.date === d)?.status ?? null, pending: requests.find((r) => r.date === d && r.state === "pending")?.status ?? null })), counts: sum, estimate },
    corrections: corrSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (iso(a.createdAt) || "") < (iso(b.createdAt) || "") ? 1 : -1).slice(0, 10).map((c) => ({ id: c.id, date: c.date ?? null, message: c.message, state: c.state, answer: c.resolution ?? null })),
    requests: requests.slice(0, 20).map((r) => ({ id: r.id, date: r.date, status: r.status, statusLabel: ATTENDANCE_STATUSES[r.status]?.label ?? r.status, note: r.note ?? null, state: r.state, answer: r.decisionNote ?? null })),
    salaries: payrolls.slice(0, 8).map(salaryView),
    // Owner-pilot refinement: salary paid early that turned out more than
    // earned, and the payroll it's planned to come off (set by the employer).
    adjustments: payrolls
      .filter((p) => p.status === "released")
      .map((p) => ({ p, r: reconcileOf(p, today) }))
      .filter(({ r }) => r && r.outstanding > 0)
      .map(({ p, r }) => {
        const target = payrolls.find((x) => x.status === "draft" && overpaymentLinesFor(x.periodStart, staff, payrolls, today).some((l) => l.sourcePayrollId === p.id));
        return { amount: r.outstanding, from: { start: p.periodStart, end: p.periodEnd }, plannedFor: target ? { start: target.periodStart, end: target.periodEnd } : null };
      }),
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

// "I received this advance". Separate from the Owner releasing it; only
// their own released advance.
export async function confirmAdvanceReceived({ db, tenant, FieldValue, staffId, advanceId, actor }) {
  const id = linked(staffId);
  if (typeof advanceId !== "string" || !/^[A-Za-z0-9]{8,40}$/.test(advanceId)) throw new PayrollError("not-found", "Advance not found");
  const ref = tenant.doc("advances", advanceId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().staffId !== id) throw new PayrollError("not-found", "Advance not found");
    const a = snap.data();
    if (a.status !== "paid") throw new PayrollError("advance-not-approved", "Your employer hasn't given this advance yet");
    if (a.receipt?.state === "confirmed") return { advanceId, received: "confirmed", alreadyConfirmed: true };
    const notes = await prepareNotifications(tx, {
      tenant,
      actor,
      events: [{ type: "household.advance_received", key: `${advanceId}-received`, title: "Advance confirmed", message: `${a.staffName} confirmed receiving the ${peso(a.amount)} advance${a.paidDate ? ` (${dayRange(a.paidDate, a.paidDate)})` : ""}.`, recordType: "advance", recordId: advanceId }],
    });
    const stamp = FieldValue.serverTimestamp();
    tx.update(ref, { receipt: { state: "confirmed", at: new Date(), by: { uid: actor.uid, name: actor.name ?? null } }, history: append(a.history, { at: new Date(), actor: { uid: actor.uid, name: actor.name ?? null }, label: `${a.staffName} confirmed receiving it` }), updatedAt: stamp });
    notes.commit({ FieldValue, actor });
    return { advanceId, received: "confirmed" };
  }, TX_OPTIONS);
}

// Their own proof only (salary or advance): the record must belong to the
// staff record linked to their account.
export async function myProof({ tenant, bucket, businessId, staffId, kind, recordId }) {
  const id = linked(staffId);
  if (typeof recordId !== "string" || !/^[A-Za-z0-9_-]{8,60}$/.test(recordId)) throw new PayrollError("not-found", "Proof not found");
  if (kind === "salary") {
    const m = /^([A-Za-z0-9]{8,40})_(\d{4}-\d{2}-\d{2})$/.exec(recordId);
    if (!m || m[1] !== id) throw new PayrollError("not-found", "Proof not found");
    const snap = await tenant.doc("payrolls", recordId).get();
    if (!snap.exists || snap.data().staffId !== id || !snap.data().salary?.proof) throw new PayrollError("not-found", "Proof not found");
    return readProofFile({ bucket, businessId, proof: snap.data().salary.proof });
  }
  if (kind === "advance") {
    const snap = await tenant.doc("advances", recordId).get();
    if (!snap.exists || snap.data().staffId !== id || !snap.data().proof) throw new PayrollError("not-found", "Proof not found");
    return readProofFile({ bucket, businessId, proof: snap.data().proof });
  }
  throw new PayrollError("not-found", "Proof not found");
}
