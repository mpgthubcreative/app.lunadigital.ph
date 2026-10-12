// Household / Kasambahay Payroll (Phase 14), server side. Every write is ONE
// Firestore transaction (all reads first). The browser says WHAT happened
// (a day's status, an advance released, a salary paid); the server works
// out payable days, base pay, deductions and net pay.
//
// Serialization: anything that changes which advances a payroll deducts
// (preparing a payroll, marking an advance paid, deleting a draft) also
// writes the staff member's document, so those transactions can never
// interleave and an advance is never deducted twice or skipped.
// Attendance edits and a salary release both touch the payroll document,
// so a release can't miss an edit made at the same moment.
//
// Documents (businesses/{bid}/...): householdStaff, attendance, payrolls,
// advances (see shared/payroll.js). Top level, server only:
//   receiptLinks/{sha256(token)}  { businessId, payrollId, expiresAt, usedAt }
// The token itself is never stored; it's returned once, when issued.

import { createHash, randomBytes } from "node:crypto";
import { decodeProof } from "./payments.js";
import { reserveStorage, prepareStorageFinalize, releaseStorageReservation } from "./storage-usage.js";
import { payrollEligibility,
  staffPeriod,
  staffPeriods,
  paidPayrollLocks,
  advanceCapacity,
  cycleLabel,
  PAYROLL_SCHEMA_VERSION,
  PayrollError,
  ATTENDANCE_STATUSES,
  SALARY_METHODS,
  RECEIPT_LINK_DAYS,
  MAX_DEDUCTIONS_PER_PAYROLL,
  attendanceId,
  payrollId as payrollIdOf,
  isValidStaffId,
  isValidAdvanceId,
  isValidPayrollId,
  periodFor,
  isPeriodOf,
  daysIn,
  summarizeAttendance,
  lineContribution,
  deductionsTotal,
  validateStaffInput,
  validateAttendanceInput,
  validateAdvanceInput,
  validateAdvanceRelease,
  validateManualDeduction,
  validateSalaryRelease,
  validateAttendanceRequest,
  validateAttendanceDays,
  selfDayLock,
  validateDecision,
  validateAdvanceRequest,
  validateAdvanceApproval,
  validateInstallment,
  applyLineChange,
  advanceRemaining,
  nextDeduction,
  ADVANCE_STATUSES,
  plannedEntries,
  plannedFor,
  scheduleOf,
  validateScheduleInput,
  validateRepayment,
  MAX_SCHEDULE_ENTRIES,
} from "../../../shared/payroll.js";
import { businessDate, isDayId, addDays } from "../../../shared/metrics.js";
import { prepareNotifications } from "./notifications.js";
import { tenantDb } from "./tenant-db.js";
import { meterActivity } from "./metering.js";

const TX_OPTIONS = { maxAttempts: 10 };
const MAX_HISTORY = 200;
const lower = (s) => (s || "").toLocaleLowerCase("en");
const peso = (c) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const statusLabel = (s) => ATTENDANCE_STATUSES[s]?.label ?? "Not marked";

function append(list, entry) {
  const l = Array.isArray(list) ? list : [];
  if (l.length >= MAX_HISTORY) throw new PayrollError("history-full", "Too many changes on this record");
  return [...l, entry];
}
const entry = (actor, label, extra = {}) => ({ at: new Date(), actor: actor ? { uid: actor.uid, name: actor.name } : null, label, ...extra });

const staffRef = (tenant, id) => {
  if (!isValidStaffId(id)) throw new PayrollError("invalid-staff", "Choose a staff member");
  return tenant.doc("householdStaff", id);
};
const payrollRef = (tenant, id) => {
  if (!isValidPayrollId(id)) throw new PayrollError("invalid-payroll", "Invalid payroll");
  return tenant.doc("payrolls", id);
};
const advanceRef = (tenant, id) => {
  if (!isValidAdvanceId(id)) throw new PayrollError("invalid-advance", "Invalid advance");
  return tenant.doc("advances", id);
};

async function loadStaff(tx, tenant, staffId) {
  const snap = await tx.get(staffRef(tenant, staffId));
  if (!snap.exists) throw new PayrollError("not-found", "Staff member not found");
  return snap.data();
}

// ---------- Household staff ----------

export async function createStaff({ db, tenant, FieldValue, input, actor }) {
  const data = validateStaffInput(input);
  const ref = tenant.collection("householdStaff").doc();
  const stamp = FieldValue.serverTimestamp();
  await ref.create({
    schemaVersion: PAYROLL_SCHEMA_VERSION,
    ...data,
    nameLower: lower(data.name),
    status: "active",
    revision: 1,
    history: [entry(actor, `Added at ${peso(data.dailyWage)} a day`)],
    createdBy: actor,
    createdAt: stamp,
    updatedBy: actor,
    updatedAt: stamp,
  });
  return { staffId: ref.id };
}

export async function updateStaff({ db, tenant, FieldValue, staffId, changes, actor }) {
  const data = validateStaffInput(changes, { partial: true });
  const ref = staffRef(tenant, staffId);
  return db.runTransaction(async (tx) => {
    const current = await loadStaff(tx, tenant, staffId);
    // Cutoffs belong to semi-monthly pay: another cycle clears them.
    const cycle = data.payCycle ?? current.payCycle;
    if (cycle !== "semi_monthly" && "payCycle" in data) data.cutoffs = null;
    if (cycle !== "semi_monthly" && data.cutoffs) throw new PayrollError("invalid-input", "Cutoff days are for semi-monthly pay");
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const changed = Object.keys(data).filter((k) => !same(current[k], data[k]));
    if (!changed.length) return { staffId, unchanged: true };
    // A pay cycle / cutoff change would orphan an unpaid payroll's period.
    if (changed.includes("payCycle") || changed.includes("cutoffs")) {
      const drafts = await tx.get(tenant.collection("payrolls").where("staffId", "==", staffId).where("status", "==", "draft").limit(1));
      if (!drafts.empty) throw new PayrollError("has-draft-payroll", "Pay or delete this person's unpaid payroll before changing the pay cycle");
    }
    const limitText = (v) => (Number.isSafeInteger(v) ? peso(v) : "no limit");
    const labels = changed.map((k) => (k === "dailyWage" ? `Daily wage changed ${peso(current.dailyWage)} → ${peso(data.dailyWage)}` : k === "notes" ? "Notes updated" : k === "advanceLimit" ? `Advance limit ${limitText(current.advanceLimit)} → ${limitText(data.advanceLimit)}` : k === "cutoffs" || k === "payCycle" ? `Pay cycle: ${cycleLabel({ payCycle: cycle, cutoffs: data.cutoffs ?? current.cutoffs ?? null })}` : `${k} changed`)).filter((l, i, all) => all.indexOf(l) === i);
    tx.update(ref, { ...Object.fromEntries(changed.map((k) => [k, data[k]])), ...(changed.includes("name") ? { nameLower: lower(data.name) } : {}), history: append(current.history, entry(actor, labels.join(" · "))), revision: (current.revision || 1) + 1, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
    return { staffId };
  }, TX_OPTIONS);
}

// Deactivate: employment ends today (unless an end date was already set),
// so the final pay period can still be prepared but no later one is.
// History (attendance, leave, advances, payroll, receipts) is kept as is.
// Reactivate: an end date that deactivation set is cleared again.
export async function setStaffStatus({ db, tenant, FieldValue, business = null, staffId, status, actor, now = new Date() }) {
  if (!["active", "inactive"].includes(status)) throw new PayrollError("invalid-input", "Status must be active or inactive");
  const ref = staffRef(tenant, staffId);
  const today = businessDate(business?.timezone || "Asia/Manila", now);
  return db.runTransaction(async (tx) => {
    const current = await loadStaff(tx, tenant, staffId);
    if (current.status === status) return { staffId, unchanged: true };
    const ending = status === "inactive" && !current.endDate ? { endDate: today, endDateFromDeactivation: true } : {};
    const resuming = status === "active" && current.endDateFromDeactivation ? { endDate: null, endDateFromDeactivation: false } : {};
    const label = status === "active" ? "Reactivated" : `Deactivated${ending.endDate ? ` (employment ended ${ending.endDate})` : ""}`;
    tx.update(ref, { status, ...ending, ...resuming, history: append(current.history, entry(actor, label)), revision: (current.revision || 1) + 1, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
    const endDate = "endDate" in ending ? ending.endDate : "endDate" in resuming ? resuming.endDate : current.endDate ?? null;
    return { staffId, status, endDate };
  }, TX_OPTIONS);
}

// Phase 18.5 · ⋯ More -> Delete: only someone with no attendance, payroll
// or advance at all (added by mistake). Anyone with history is deactivated
// instead, so pay records always keep their person. Attendance, payroll
// and advance writes all read the staff document, so they can't slip in
// while this runs. A snapshot goes to the audit log.
export async function deleteStaff({ db, tenant, FieldValue, staffId, actor }) {
  const ref = staffRef(tenant, staffId);
  return db.runTransaction(async (tx) => {
    const current = await loadStaff(tx, tenant, staffId);
    // Phase 18.6: a person with a login keeps their record (turn the login off instead).
    if (current.memberUid) throw new PayrollError("staff-in-use", "This person has a Luna login. Turn the login off or deactivate them instead");
    const used = await Promise.all(["attendance", "payrolls", "advances"].map((c) => tx.get(tenant.collection(c).where("staffId", "==", staffId).limit(1))));
    if (used.some((q) => !q.empty)) throw new PayrollError("staff-in-use", "This person has attendance, payroll or advances. Deactivate them instead");
    const stamp = FieldValue.serverTimestamp();
    tx.delete(ref);
    tx.set(tenant.collection("auditLog").doc(), { type: "staff.deleted", staffId, snapshot: { name: current.name, position: current.position ?? null, dailyWage: current.dailyWage, payCycle: current.payCycle, status: current.status, history: current.history ?? [] }, actor, at: stamp });
    return { staffId, deleted: true };
  }, TX_OPTIONS);
}

// ---------- Attendance ----------

// Marks (or changes) one person's status for one day. The day's payable
// amount uses the person's CURRENT daily wage. If an unpaid (draft) payroll
// covers the day, its counts and base pay move in the same transaction; a
// paid payroll's days are locked.
// A correction of a day the employee sent (approved from their request)
// needs the Owner's reason; it's kept in the day's history with before /
// after, who and when. A paid payroll's days stay locked (as before).
export async function setAttendance({ db, tenant, FieldValue, business, input, actor, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  const { staffId, date, status, note, reason } = validateAttendanceInput(input, { today });
  return db.runTransaction(async (tx) => {
    const plan = await prepareAttendanceWrite(tx, { tenant, staffId, date });
    if (plan.fromStaff && plan.before && plan.before.status !== status && !reason) throw new PayrollError("reason-required", "Say why you're correcting what the employee sent");
    return plan.commit({ FieldValue, status, note, actor, reason });
  }, TX_OPTIONS);
}

// Phase 18.6: reads for one attendance line (staff, the line, its payroll);
// commit() writes it, moving an unpaid payroll's counts with it. Shared by
// the owner's direct marking and the approval of a staff request.
async function prepareAttendanceWrite(tx, { tenant, staffId, date }) {
  const lineRef = tenant.doc("attendance", attendanceId(staffId, date));
  const staff = await loadStaff(tx, tenant, staffId);
  if (staff.status !== "active") throw new PayrollError("inactive-staff", `${staff.name} is inactive`);
  if (staff.startDate && date < staff.startDate) throw new PayrollError("invalid-date", `${staff.name} started on ${staff.startDate}`);
  const period = staffPeriod(staff, date);
  const pRef = tenant.doc("payrolls", payrollIdOf(staffId, period.start));
  const [lineSnap, paySnap] = await Promise.all([tx.get(lineRef), tx.get(pRef)]);
  const before = lineSnap.exists ? lineSnap.data() : null;
  const payroll = paySnap.exists ? paySnap.data() : null;
  // Owner-pilot batch: an EARLY payment keeps the days after its payment
  // date open (the period hadn't finished); otherwise a paid period is locked.
  if (paidPayrollLocks(payroll, date)) throw new PayrollError("payroll-released", `This day is in a payroll that's already paid (${payroll.periodStart} to ${payroll.periodEnd})`);
  // A day already paid in ANOTHER payroll (the pay cycle changed since) stays locked.
  if (before?.payrollId && before.payrollId !== pRef.id) {
    const other = await tx.get(tenant.doc("payrolls", before.payrollId));
    if (other.exists && paidPayrollLocks(other.data(), date)) throw new PayrollError("payroll-released", `This day is in a payroll that's already paid (${other.data().periodStart} to ${other.data().periodEnd})`);
  }
  return {
    staff,
    before,
    // The day came from the employee's own request (approved by the Owner).
    fromStaff: Boolean(before && (before.source === "staff_request" || (before.history || []).some((h) => /request, approved/.test(h.label || "")))),
    commit({ FieldValue, status, note, actor, via = null, reason = null }) {
    if (before && before.status === status && (before.note ?? null) === note) return { staffId, date, status, unchanged: true };

    const payable = ATTENDANCE_STATUSES[status].payable;
    const line = {
      schemaVersion: PAYROLL_SCHEMA_VERSION,
      staffId,
      staffName: staff.name,
      date,
      status,
      dailyWage: staff.dailyWage,
      payable,
      payableAmount: payable ? staff.dailyWage : 0,
      note,
      payrollId: payroll ? pRef.id : null,
      history: append(before?.history, entry(actor, `${before ? `${statusLabel(before.status)} → ${statusLabel(status)}` : `Marked ${statusLabel(status)}`}${via ? ` (${via})` : ""}${reason ? ` · Reason: ${reason}` : ""}`, { from: before?.status ?? null, to: status, ...(reason ? { reason } : {}) })),
      ...(via ? { source: "staff_request" } : before?.source ? {} : { source: "owner" }),
      updatedBy: actor,
      updatedAt: FieldValue.serverTimestamp(),
      ...(before ? {} : { createdAt: FieldValue.serverTimestamp(), createdBy: actor }),
    };
    tx.set(lineRef, line, { merge: true });

    if (payroll) {
      const next = applyLineChange(payroll, before, line);
      tx.update(pRef, { ...next, ...payTotals(payroll, { basePay: next.basePay }), revision: (payroll.revision || 1) + 1, updatedAt: FieldValue.serverTimestamp() });
    }
    return { staffId, date, status, payable };
    },
  };
}

// Phase 18.6: Gross = basic pay + additions (bonus, 13th month);
// Net = Gross - deductions. Older payrolls have no additions (0).
export function payTotals(p, changes = {}) {
  const basePay = changes.basePay ?? p.basePay ?? 0;
  const additionsTotal = changes.additionsTotal ?? (Number.isSafeInteger(p.additionsTotal) ? p.additionsTotal : 0);
  const deductionsTotalValue = changes.deductionsTotal ?? (Number.isSafeInteger(p.deductionsTotal) ? p.deductionsTotal : 0);
  return { additionsTotal, grossPay: basePay + additionsTotal, netPay: basePay + additionsTotal - deductionsTotalValue };
}

// ---------- Advances ----------

export async function createAdvance({ db, tenant, FieldValue, business, input, actor, now = new Date() }) {
  const data = validateAdvanceInput(input, { today: businessDate(business.timezone, now) });
  const ref = tenant.collection("advances").doc();
  return db.runTransaction(async (tx) => {
    const staff = await loadStaff(tx, tenant, data.staffId);
    await checkAdvanceLimit(tx, tenant, staff, data.staffId, data.amount, { stage: "approve" });
    const stamp = FieldValue.serverTimestamp();
    tx.update(staffRef(tenant, data.staffId), { advanceTouchedAt: stamp });
    tx.create(ref, { schemaVersion: PAYROLL_SCHEMA_VERSION, ...data, staffName: staff.name, status: "not_yet_paid", requestedAmount: null, paidDate: null, method: null, reference: null, paidBy: null, deductionPayrollId: null, deducted: false, deductedAmount: 0, deductionLog: [], skipPayrollIds: [], history: [entry(actor, `Advance recorded ${peso(data.amount)}${data.installment ? ` · ${peso(data.installment)} per payroll` : ""}`)], revision: 1, createdBy: actor, createdAt: stamp, updatedBy: actor, updatedAt: stamp });
    return { advanceId: ref.id };
  }, TX_OPTIONS);
}

export async function updateAdvance({ db, tenant, FieldValue, business, advanceId, changes, actor, now = new Date() }) {
  const ref = advanceRef(tenant, advanceId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PayrollError("not-found", "Advance not found");
    const a = snap.data();
    if (a.status !== "not_yet_paid") throw new PayrollError("advance-paid", a.status === "paid" ? "A released advance can't be edited" : "Approve or reject this request instead");
    const data = validateAdvanceInput({ staffId: a.staffId, date: changes?.date ?? a.date, description: "description" in (changes || {}) ? changes.description : a.description, amount: changes?.amount ?? a.amount, installment: "installment" in (changes || {}) ? changes.installment : a.installment ?? null }, { today: businessDate(business.timezone, now) });
    for (const k of Object.keys(changes || {})) if (!["date", "description", "amount", "installment"].includes(k)) throw new PayrollError("invalid-input", `Field ${k} can't be changed here`);
    if (data.amount > a.amount) {
      const staff = await loadStaff(tx, tenant, a.staffId);
      await checkAdvanceLimit(tx, tenant, staff, a.staffId, data.amount, { stage: "approve", exclude: advanceId });
      tx.update(staffRef(tenant, a.staffId), { advanceTouchedAt: FieldValue.serverTimestamp() });
    }
    const label = [data.amount !== a.amount ? `Amount changed ${peso(a.amount)} → ${peso(data.amount)}` : null, (data.installment ?? null) !== (a.installment ?? null) ? (data.installment ? `Deduct ${peso(data.installment)} per payroll` : "Deduct all at once") : null].filter(Boolean).join(" · ") || "Advance edited";
    tx.update(ref, { date: data.date, description: data.description, amount: data.amount, installment: data.installment, history: append(a.history, entry(actor, label)), revision: (a.revision || 1) + 1, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
    return { advanceId };
  }, TX_OPTIONS);
}

// Owner-pilot change: an advance whose money was never given (requested,
// approved or rejected) can be deleted outright; a released one is voided
// instead (voidAdvance). Deleting twice is fine (already gone).
export async function deleteAdvance({ db, tenant, FieldValue = null, advanceId, actor = null }) {
  const ref = advanceRef(tenant, advanceId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { advanceId, deleted: true, alreadyGone: true };
    const a = snap.data();
    if (a.status === "paid") throw new PayrollError("advance-paid", "This advance was given: void it instead (with a reason)");
    tx.delete(ref);
    tx.set(tenant.collection("auditLog").doc(), { type: "advance.deleted", advanceId, staffId: a.staffId, staffName: a.staffName, amount: a.amount, status: a.status, actor, at: FieldValue ? FieldValue.serverTimestamp() : new Date() });
    return { advanceId, deleted: true };
  }, TX_OPTIONS);
}

// Owner-pilot batch: the person's cash advance limit, checked inside the
// caller's transaction (which also writes the staff document, so two
// approvals / releases can't both use the same room). `stage`:
//   request  staff asking: limit - outstanding - approved - other requests
//   approve  Owner approving / recording: limit - outstanding - approved
//   release  money handed over: limit - outstanding
export async function checkAdvanceLimit(tx, tenant, staff, staffId, amount, { stage, exclude = null }) {
  if (!Number.isSafeInteger(staff.advanceLimit)) return null;
  const all = (await tx.get(tenant.collection("advances").where("staffId", "==", staffId))).docs.map((d) => ({ id: d.id, ...d.data() }));
  const cap = advanceCapacity(staff, all, { exclude });
  const room = stage === "release" ? Math.max(0, cap.limit - cap.outstanding) : stage === "request" ? Math.max(0, cap.available - cap.requested) : cap.available;
  if (amount <= room) return cap;
  if (stage === "request") {
    if (cap.limit === 0) throw new PayrollError("over-advance-limit", "Cash advances aren't available for you right now. Ask your employer.");
    if (room === 0 && cap.outstanding > 0 && cap.outstanding + cap.approved >= cap.limit) throw new PayrollError("over-advance-limit", `You still have ${peso(cap.outstanding)} to repay before you can request another advance.`);
    if (room === 0) throw new PayrollError("over-advance-limit", "You can't request more right now. Wait for your employer to answer your other request.");
    throw new PayrollError("over-advance-limit", `You can request up to ${peso(room)} right now.`);
  }
  throw new PayrollError("over-advance-limit", `${staff.name}'s advance limit is ${peso(cap.limit)}: ${peso(cap.outstanding)} still to repay${stage !== "release" && cap.approved ? `, ${peso(cap.approved)} approved, not released` : ""}. At most ${peso(room)} more${stage === "release" ? " can be released" : ""}. Raise the limit on Household Staff to allow more.`);
}

// One payroll line per advance: what its repayment plan takes from this
// pay period (each advance stays traceable; several can share a payroll).
const advanceLine = (a, amount) => {
  const partial = amount < advanceRemaining(a) || advanceRemaining(a) < a.amount;
  return { id: `adv-${a.id}`, type: "advance", advanceId: a.id, description: `Advance ${a.paidDate || a.date}${a.description ? ` (${a.description})` : ""}${partial ? ` · ${peso(amount)} of ${peso(advanceRemaining(a))} owed` : ""}`, amount };
};
// The advance lines of one pay period, from the plans of the person's
// released advances.
export function advanceLinesFor(periodStart, advances) {
  return (advances || [])
    .filter((a) => a.status === "paid" && advanceRemaining(a) > 0)
    .map((a) => [a, plannedFor(a, periodStart)])
    .filter(([, amount]) => amount > 0)
    .slice(0, MAX_DEDUCTIONS_PER_PAYROLL)
    .map(([a, amount]) => advanceLine(a, amount));
}

// Owner-pilot simplification batch: the first pay period from `fromDay` on
// whose payroll isn't paid yet (a salary paid early never takes a new advance).
export function nextUnpaidPeriod(staff, payrolls, fromDay) {
  let p = staffPeriod(staff, fromDay);
  for (let i = 0; i < 48; i++) {
    const pay = payrolls.find((x) => x.periodStart === p.start);
    if (!pay || pay.status === "draft") return p;
    p = staffPeriod(staff, addDays(p.end, 1));
  }
  return p;
}
const newEntry = (period, amount, state = "planned", extra = {}) => ({ id: randomBytes(4).toString("hex"), periodStart: period.start, periodEnd: period.end, amount, state, ...extra });
// A new advance's default plan: all of it (or its amount per payroll) from
// the next unpaid payroll on. The Owner can change it any time.
export function defaultSchedule(staff, payrolls, a, fromDay) {
  const out = [];
  let left = advanceRemaining(a);
  const step = Number.isSafeInteger(a.installment) && a.installment > 0 ? a.installment : left;
  let period = nextUnpaidPeriod(staff, payrolls, fromDay);
  while (left > 0) {
    const amount = out.length === MAX_SCHEDULE_ENTRIES - 1 ? left : Math.min(step, left);
    out.push(newEntry(period, amount));
    left -= amount;
    period = nextUnpaidPeriod(staff, payrolls, addDays(period.end, 1));
  }
  return out;
}

// Keeps the person's STORED unpaid payrolls in step with their advances'
// plans (a period nobody touched is always worked out fresh). Manual lines
// stay; advance lines are replaced.
function syncDraftLines(tx, tenant, payroll, advancesAfter, FieldValue) {
  const manual = (payroll.deductions || []).filter((d) => d.type !== "advance");
  const deductions = [...manual, ...advanceLinesFor(payroll.periodStart, advancesAfter)];
  if (JSON.stringify(deductions) === JSON.stringify(payroll.deductions || [])) return;
  const total = deductionsTotal(deductions);
  tx.update(tenant.doc("payrolls", payroll.id), { deductions, deductionsTotal: total, ...payTotals(payroll, { deductionsTotal: total }), revision: (payroll.revision || 1) + 1, updatedAt: FieldValue.serverTimestamp() });
}
const plannedPeriods = (a) => new Set(plannedEntries(a).map((e) => e.periodStart));

// One change to one released advance's plan or balance, in ONE transaction
// that also brings the affected unpaid payrolls up to date. `change` gets
// { a, staff, payrolls, all, today } and returns { updates, label, result }.
async function changeAdvance({ db, tenant, FieldValue, advanceId, actor, today, change }) {
  const aRef = advanceRef(tenant, advanceId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(aRef);
    if (!snap.exists) throw new PayrollError("not-found", "Advance not found");
    const a = { id: snap.id, ...snap.data() };
    if (a.status !== "paid") throw new PayrollError("advance-not-approved", "Release the advance first");
    const staff = await loadStaff(tx, tenant, a.staffId);
    const payrolls = await staffPayrolls(tx, tenant, a.staffId);
    const all = (await tx.get(tenant.collection("advances").where("staffId", "==", a.staffId))).docs.map((d) => ({ id: d.id, ...d.data() }));
    const { updates, label, result } = change({ a, staff, payrolls, all, today });
    const after = { ...a, ...updates };
    const touched = new Set([...plannedPeriods(a), ...plannedPeriods(after)]);
    const stamp = FieldValue.serverTimestamp();
    tx.update(aRef, { ...updates, history: append(a.history, entry(actor, label)), revision: (a.revision || 1) + 1, updatedBy: actor, updatedAt: stamp });
    const advancesAfter = all.map((x) => (x.id === a.id ? after : x));
    for (const p of payrolls) if (p.status === "draft" && touched.has(p.periodStart)) syncDraftLines(tx, tenant, p, advancesAfter, FieldValue);
    tx.update(staffRef(tenant, a.staffId), { payrollTouchedAt: stamp });
    return { advanceId, ...result };
  }, TX_OPTIONS);
}

const periodName = (e) => `${e.periodStart} to ${e.periodEnd}`;

// The Owner's repayment plan for an advance. Planned deductions only go to
// payrolls not paid yet; planned + not taken never exceed what's owed.
// Deducted / repaid entries are history and stay as they are. A plan never
// changes the debt: only payroll deductions and repayments do.
export async function setAdvanceSchedule({ db, tenant, FieldValue, business, advanceId, schedule, actor, now = new Date() }) {
  const wanted = validateScheduleInput(schedule);
  return changeAdvance({
    db, tenant, FieldValue, advanceId, actor, today: businessDate(business.timezone, now),
    change: ({ a, staff, payrolls }) => {
      const owed = advanceRemaining(a);
      const entries = wanted.map((w) => {
        const period = staffPeriod(staff, w.periodStart);
        if (period.start !== w.periodStart) throw new PayrollError("invalid-period", `${w.periodStart} isn't the start of one of ${staff.name}'s pay periods`);
        const pay = payrolls.find((x) => x.periodStart === period.start);
        if (w.state === "planned" && pay && pay.status !== "draft") throw new PayrollError("payroll-released", `The ${periodName({ periodStart: period.start, periodEnd: period.end })} salary is already paid. Choose a later payroll, or record a separate repayment.`);
        const kept = scheduleOf(a).find((e) => e.state === w.state && e.periodStart === w.periodStart);
        return { ...(kept || newEntry(period, w.amount, w.state)), amount: w.amount, periodEnd: period.end };
      });
      const total = entries.reduce((t, e) => t + e.amount, 0);
      if (total > owed) throw new PayrollError("over-owed", `That plan is ${peso(total)}, but only ${peso(owed)} is still owed`);
      const history = scheduleOf(a).filter((e) => e.state === "applied" || e.state === "repaid");
      const plan = entries.filter((e) => e.state === "planned").map((e) => `${peso(e.amount)} ${periodName(e)}`).join(", ") || "nothing planned";
      return { updates: { schedule: [...history, ...entries] }, label: `Repayment plan: ${plan}`, result: { schedule: [...history, ...entries] } };
    },
  });
}

// Money given back outside payroll (cash, GCash...). Reduces what's owed
// right away. From a "not taken" deduction it settles that entry.
export async function recordAdvanceRepayment({ db, tenant, FieldValue, business, advanceId, repayment, actor, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  const r = validateRepayment(repayment, { today });
  return changeAdvance({
    db, tenant, FieldValue, advanceId, actor, today,
    change: ({ a }) => {
      const owed = advanceRemaining(a);
      if (r.amount > owed) throw new PayrollError("over-owed", `Only ${peso(owed)} is still owed`);
      let schedule = scheduleOf(a).map((e) => ({ ...e }));
      // Settle the not-taken entry it came from (if any).
      if (r.notTakenPeriod) {
        let left = r.amount;
        schedule = schedule.flatMap((e) => {
          if (e.state !== "not_taken" || e.periodStart !== r.notTakenPeriod || left <= 0) return [e];
          const used = Math.min(left, e.amount);
          left -= used;
          return [{ ...e, amount: used, state: "repaid", repaidOn: r.date }, ...(e.amount > used ? [{ ...e, id: `${e.id}r`, amount: e.amount - used }] : [])];
        });
      }
      // What's still planned or not taken can't exceed the new balance:
      // trim from the latest planned deductions first.
      const newOwed = owed - r.amount;
      let excess = schedule.filter((e) => e.state === "planned" || e.state === "not_taken").reduce((t, e) => t + e.amount, 0) - newOwed;
      if (excess > 0) {
        const order = [...schedule.keys()].filter((i) => schedule[i].state === "planned" || schedule[i].state === "not_taken").sort((x, y) => (schedule[x].periodStart < schedule[y].periodStart ? 1 : -1));
        for (const i of order) {
          if (excess <= 0) break;
          const cut = Math.min(excess, schedule[i].amount);
          schedule[i] = { ...schedule[i], amount: schedule[i].amount - cut };
          excess -= cut;
        }
        schedule = schedule.filter((e) => e.amount > 0);
      }
      const repaidAmount = (Number.isSafeInteger(a.repaidAmount) ? a.repaidAmount : 0) + r.amount;
      const repayments = [...(Array.isArray(a.repayments) ? a.repayments : []), { amount: r.amount, date: r.date, method: r.method, reference: r.reference, note: r.note, by: actor ? { uid: actor.uid, name: actor.name } : null, at: new Date() }].slice(-100);
      const done = newOwed === 0;
      return {
        updates: { repaidAmount, repayments, schedule, deducted: done, ...(done ? { repaidAt: new Date() } : {}) },
        label: `Repaid separately ${peso(r.amount)} on ${r.date} via ${SALARY_METHODS[r.method].label}${r.reference ? ` · Ref ${r.reference}` : ""}${r.note ? ` · ${r.note}` : ""} · ${done ? "fully repaid" : `${peso(newOwed)} left`}`,
        result: { remaining: newOwed },
      };
    },
  });
}

// Released to the employee (Paid). From then on its repayment plan decides
// which payrolls deduct it (default: all of it from the next unpaid one).
// Optional proof (GCash / bank screenshot or PDF), stored privately.
export async function markAdvancePaid({ db, bucket = null, tenant, FieldValue, business, advanceId, release, proof = null, actor, now = new Date() }) {
  const data = validateAdvanceRelease(release, { today: businessDate(business.timezone, now) });
  if (proof && !bucket) throw new PayrollError("invalid-input", "Proof uploads aren't available");
  const stored = proof ? await storeProofFile({ db, bucket, tenant, FieldValue, businessId: tenant.businessId, recordType: "advance", recordId: advanceId, proof, actor, now }) : null;
  try {
    return await markPaidOnce({ db, tenant, FieldValue, advanceId, data, stored, actor });
  } catch (err) {
    if (stored) await undoSalaryProof({ db, bucket, tenant, FieldValue, stored });
    throw err;
  }
}

async function markPaidOnce({ db, tenant, FieldValue, advanceId, data, stored, actor }) {
  const ref = advanceRef(tenant, advanceId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PayrollError("not-found", "Advance not found");
    const a = snap.data();
    if (a.status === "paid") throw new PayrollError("advance-paid", "This advance is already marked paid");
    if (a.status !== "not_yet_paid") throw new PayrollError("advance-not-approved", a.status === "requested" ? "Approve the request first" : "A rejected request can't be released");
    const sRef = staffRef(tenant, a.staffId);
    const staff = await loadStaff(tx, tenant, a.staffId);
    await checkAdvanceLimit(tx, tenant, staff, a.staffId, a.amount, { stage: "release", exclude: advanceId });
    const payrolls = await staffPayrolls(tx, tenant, a.staffId);
    const all = (await tx.get(tenant.collection("advances").where("staffId", "==", a.staffId))).docs.map((d) => ({ id: d.id, ...d.data() }));
    const file = stored ? await prepareStorageFinalize(tx, { tenant, objectId: stored.objectId }) : null;
    // Owner-pilot simplification batch: released -> a repayment plan, from
    // the next payroll that isn't paid yet (the Owner can change it).
    const released = { ...a, id: advanceId, status: "paid", paidDate: data.paidDate };
    const schedule = defaultSchedule(staff, payrolls, released, data.paidDate);
    const after = { ...released, schedule };
    const stamp = FieldValue.serverTimestamp();
    file?.commit({ FieldValue });
    tx.update(ref, { status: "paid", ...data, paidBy: actor, schedule, deductionPayrollId: null, receipt: { state: "awaiting" }, ...(stored ? { proof: stored } : {}), history: append(a.history, entry(actor, `Released ${data.paidDate} via ${SALARY_METHODS[data.method].label}${data.reference ? ` · Ref ${data.reference}` : ""} · deduct ${schedule.map((e) => `${peso(e.amount)} ${periodName(e)}`).join(", ")}`)), revision: (a.revision || 1) + 1, updatedBy: actor, updatedAt: stamp });
    const periods = new Set(schedule.map((e) => e.periodStart));
    const advancesAfter = all.map((x) => (x.id === advanceId ? after : x));
    for (const p of payrolls) if (p.status === "draft" && periods.has(p.periodStart)) syncDraftLines(tx, tenant, p, advancesAfter, FieldValue);
    tx.update(sRef, { payrollTouchedAt: stamp });
    return { advanceId, status: "paid", schedule };
  }, TX_OPTIONS);
}

// ---------- Payroll ----------

// A payroll's figures from the period's attendance lines and the person's
// released advances. Shared by preparing a payroll and by the automatic
// payroll view (a period nobody touched yet is shown from these, nothing
// stored). A day already counted in another payroll (pay cycle changed
// since) isn't counted twice. Released advances: what their repayment
// plans give this period, one line per advance.
export function draftFigures({ id, period, lines, advances }) {
  const own = lines.filter((l) => !l.payrollId || l.payrollId === id);
  return { lines: own, sum: summarizeAttendance(own, period), deductions: advanceLinesFor(period.start, advances) };
}

// Prepares (or returns) the person's payroll for the period starting on
// periodStart: counts from the attendance lines, base pay, and every paid,
// not-yet-deducted advance deducted in full. Idempotent per person+period.
export async function preparePayroll({ db, tenant, FieldValue, business, staffId, periodStart, actor, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  return db.runTransaction(async (tx) => {
    const sRef = staffRef(tenant, staffId);
    const staff = await loadStaff(tx, tenant, staffId);
    const period = staffPeriod(staff, periodStart);
    if (period.start !== periodStart) throw new PayrollError("invalid-period", `A ${staff.payCycle.replace("_", "-")} period starts on ${period.start}`);
    if (period.start > today) throw new PayrollError("invalid-period", "That pay period hasn't started yet");
    // The staff record decides (employment dates, status): no second enrollment.
    const elig = payrollEligibility(staff, period);
    if (!elig.eligible) throw new PayrollError("not-eligible", `${staff.name} isn't on payroll for ${period.start} to ${period.end}: ${elig.reason}`);
    const id = payrollIdOf(staffId, period.start);
    const ref = tenant.doc("payrolls", id);
    const existing = await tx.get(ref);
    if (existing.exists) return { payrollId: id, existing: true };

    const days = daysIn(period);
    const lineSnaps = await tx.getAll(...days.map((d) => tenant.doc("attendance", attendanceId(staffId, d))));
    const adv = await tx.get(tenant.collection("advances").where("staffId", "==", staffId).where("status", "==", "paid"));
    const fig = draftFigures({ id, period, lines: lineSnaps.filter((s) => s.exists).map((s) => ({ ref: s.ref, ...s.data() })), advances: adv.docs.map((d) => ({ id: d.id, ...d.data() })) });
    const { lines, sum, deductions } = fig;
    const total = deductionsTotal(deductions);
    const stamp = FieldValue.serverTimestamp();
    tx.create(ref, {
      schemaVersion: PAYROLL_SCHEMA_VERSION,
      staffId,
      staffName: staff.name,
      payCycle: staff.payCycle,
      periodStart: period.start,
      periodEnd: period.end,
      days: days.length,
      dailyWage: staff.dailyWage,
      ...sum,
      deductions,
      deductionsTotal: total,
      additions: [],
      ...payTotals({ basePay: sum.basePay, additionsTotal: 0, deductionsTotal: total }),
      status: "draft",
      ownerPayment: "not_paid",
      salary: null,
      receiptStatus: "none",
      receiptLinkHash: null,
      receiptLinkExpiresAt: null,
      receiptConfirmedAt: null,
      receiptConfirmedVia: null,
      history: [entry(actor, "Payroll prepared")],
      revision: 1,
      createdBy: actor,
      createdAt: stamp,
      updatedBy: actor,
      updatedAt: stamp,
    });
    for (const l of lines) tx.update(l.ref, { payrollId: id });
    tx.update(sRef, { payrollTouchedAt: stamp });
    return { payrollId: id };
  }, TX_OPTIONS);
}

async function loadDraft(tx, tenant, id) {
  const ref = payrollRef(tenant, id);
  const snap = await tx.get(ref);
  if (!snap.exists) throw new PayrollError("not-found", "Payroll not found");
  const p = snap.data();
  if (p.status !== "draft") throw new PayrollError("payroll-released", "This payroll is already paid");
  return { ref, p };
}

function withDeductions(tx, { ref, p }, deductions, actor, label, FieldValue) {
  const total = deductionsTotal(deductions);
  tx.update(ref, { deductions, deductionsTotal: total, ...payTotals(p, { deductionsTotal: total }), history: append(p.history, entry(actor, label)), revision: (p.revision || 1) + 1, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
}

export async function addDeduction({ db, tenant, FieldValue, payrollId, deduction, actor }) {
  const d = validateManualDeduction(deduction);
  return db.runTransaction(async (tx) => {
    const draft = await loadDraft(tx, tenant, payrollId);
    const list = draft.p.deductions || [];
    if (list.length >= MAX_DEDUCTIONS_PER_PAYROLL) throw new PayrollError("too-many-deductions", "Too many deductions on this payroll");
    const id = `man-${randomBytes(6).toString("hex")}`;
    withDeductions(tx, draft, [...list, { id, type: "manual", ...d }], actor, `Deduction added ${peso(d.amount)} (${d.description})`, FieldValue);
    return { payrollId, deductionId: id };
  }, TX_OPTIONS);
}

export async function removeDeduction({ db, tenant, FieldValue, payrollId, deductionId, actor }) {
  return db.runTransaction(async (tx) => {
    const draft = await loadDraft(tx, tenant, payrollId);
    const list = draft.p.deductions || [];
    const d = list.find((x) => x.id === deductionId);
    if (!d) throw new PayrollError("not-found", "Deduction not found");
    if (d.type !== "manual") throw new PayrollError("advance-deduction", "An advance deduction follows its repayment plan: move it or take it off this payroll instead");
    withDeductions(tx, draft, list.filter((x) => x.id !== deductionId), actor, `Deduction removed ${peso(d.amount)} (${d.description})`, FieldValue);
    return { payrollId };
  }, TX_OPTIONS);
}

// Moves a paid advance's deduction to the person's NEXT payroll (e.g. when
// this period's pay can't cover it). It's still deducted in full, later.
// Owner-pilot simplification batch: "Move to next payroll" = this period's
// planned (or not taken) part of the advance goes to the next unpaid payroll.
export async function deferAdvance({ db, tenant, FieldValue, business = null, payrollId, advanceId, actor, now = new Date() }) {
  const m = /^([A-Za-z0-9]{8,40})_(\d{4}-\d{2}-\d{2})$/.exec(typeof payrollId === "string" ? payrollId : "");
  if (!m) throw new PayrollError("invalid-payroll", "Invalid payroll");
  const from = m[2];
  const r = await changeAdvance({
    db, tenant, FieldValue, advanceId, actor, today: businessDate(business?.timezone || "Asia/Manila", now),
    change: ({ a, staff, payrolls }) => {
      const moving = scheduleOf(a).filter((e) => (e.state === "planned" || e.state === "not_taken") && e.periodStart === from);
      if (!moving.length) throw new PayrollError("not-found", "That advance isn't planned for this payroll");
      const amount = Math.min(advanceRemaining(a), moving.reduce((t, e) => t + e.amount, 0));
      const target = nextUnpaidPeriod(staff, payrolls, addDays(staffPeriod(staff, from).end, 1));
      const rest = scheduleOf(a).filter((e) => !moving.includes(e));
      const existing = rest.find((e) => e.state === "planned" && e.periodStart === target.start);
      const schedule = existing ? rest.map((e) => (e === existing ? { ...e, amount: e.amount + amount } : e)) : [...rest, newEntry(target, amount)];
      return { updates: { schedule }, label: `${peso(amount)} moved from ${from} to the ${target.start} to ${target.end} payroll`, result: { payrollId, to: target } };
    },
  });
  return r;
}

// Owner-pilot change: deleting an UNPAID payroll removes the saved record
// and the lines added to it by hand (bonus, deductions, 13th month).
// Attendance, the staff record and advances stay; advance plans stay too,
// so the period simply shows as worked out automatically again (nothing is
// stored until the next real action). Deleting twice is fine.
export async function deleteDraftPayroll({ db, tenant, FieldValue, payrollId, actor }) {
  const ref0 = payrollRef(tenant, payrollId);
  return db.runTransaction(async (tx) => {
    if (!(await tx.get(ref0)).exists) return { payrollId, deleted: true, alreadyGone: true };
    const draft = await loadDraft(tx, tenant, payrollId);
    const sRef = staffRef(tenant, draft.p.staffId);
    await loadStaff(tx, tenant, draft.p.staffId);
    const lines = await tx.get(tenant.collection("attendance").where("payrollId", "==", payrollId));
    tx.delete(draft.ref);
    for (const l of lines.docs) tx.update(l.ref, { payrollId: null });
    tx.update(sRef, { payrollTouchedAt: FieldValue.serverTimestamp() });
    tx.set(tenant.collection("auditLog").doc(), { type: "payroll.deleted", payrollId, staffId: draft.p.staffId, staffName: draft.p.staffName, period: { start: draft.p.periodStart, end: draft.p.periodEnd }, netPay: draft.p.netPay ?? null, manualLines: [...(draft.p.additions || []), ...(draft.p.deductions || []).filter((d) => d.type === "manual")].map((x) => ({ type: x.type, description: x.description, amount: x.amount })), actor, at: FieldValue.serverTimestamp() });
    return { payrollId, deleted: true, by: actor?.uid ?? null };
  }, TX_OPTIONS);
}

const hashToken = (token) => createHash("sha256").update(token, "utf8").digest("hex");
const newToken = () => randomBytes(24).toString("base64url");

function issueLink(tx, { db, tenant, payrollId, previousHash, now }) {
  const token = newToken();
  const hash = hashToken(token);
  const expiresAt = new Date(now.getTime() + RECEIPT_LINK_DAYS * 86400000);
  if (previousHash) tx.delete(db.collection("receiptLinks").doc(previousHash));
  tx.create(db.collection("receiptLinks").doc(hash), { businessId: tenant.businessId, payrollId, expiresAt, usedAt: null, createdAt: now });
  return { token, hash, expiresAt };
}

// Pays the salary (net pay, in full) and issues the employee's one-time
// receipt link. The period's attendance is locked from now on; the paid
// advances it deducts are marked deducted. Returns the link token ONCE.
// Phase 18.6: optional payment proof (GCash / bank screenshot; stored and
// storage-metered like payment screenshots, finalized in this transaction),
// the Owner's payment status (ownerPayment: paid), and a last check that
// any 13th month pay on it still fits the year's entitlement.
export async function releaseSalary({ db, bucket = null, tenant, FieldValue, business, payrollId = null, staffId = null, periodStart = null, release, proof = null, expectedNetPay = null, actor, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  const data = validateSalaryRelease(release, { today });
  // Owner-pilot batch: a period nobody touched is stored first (once), only
  // after the payment itself is valid.
  if (!payrollId && staffId !== null) payrollId = (await preparePayroll({ db, tenant, FieldValue, business, staffId, periodStart, actor, now })).payrollId;
  if (proof && !bucket) throw new PayrollError("invalid-input", "Proof uploads aren't available");
  const stored = proof ? await storeSalaryProof({ db, bucket, tenant, FieldValue, businessId: tenant.businessId, payrollId, proof, actor, now }) : null;
  try {
    return await releaseOnce({ db, tenant, FieldValue, business, today, data, payrollId, stored, expectedNetPay, actor, now });
  } catch (err) {
    if (stored) await undoSalaryProof({ db, bucket, tenant, FieldValue, stored });
    throw err;
  }
}

async function releaseOnce({ db, tenant, FieldValue, business, today, data, payrollId, stored, expectedNetPay, actor, now }) {
  return db.runTransaction(async (tx) => {
    const draft = await loadDraft(tx, tenant, payrollId);
    const p = draft.p;
    // Owner-pilot batch: a salary may be paid before the period ends (an
    // early payment). The payment date is when the money was given: never
    // in the future (validateSalaryRelease), but it may be before the end.
    // The days after it stay open; the final pay is known once it ends.
    if (data.paidDate < p.periodStart) throw new PayrollError("invalid-date", `The payment date can't be before the pay period (${p.periodStart})`);
    if (Number.isSafeInteger(expectedNetPay) && expectedNetPay !== p.netPay) throw new PayrollError("amount-changed", `The take-home is now ${peso(p.netPay)} (attendance or advances changed). Check it and pay again.`);
    const timing = data.paidDate < p.periodEnd ? "early" : "on_time";
    if (p.netPay < 0) throw new PayrollError("negative-net-pay", "Deductions are more than this period's pay. Move an advance to the next payroll first.");
    const sRef = staffRef(tenant, p.staffId);
    await loadStaff(tx, tenant, p.staffId);
    const advSnaps = (await tx.get(tenant.collection("advances").where("staffId", "==", p.staffId).where("status", "==", "paid"))).docs;
    const thm = (p.additions || []).filter((a) => a.type === "thirteenth");
    if (thm.length) {
      const all = await staffPayrolls(tx, tenant, p.staffId);
      for (const year of new Set(thm.map((a) => a.year))) {
        const t = thirteenthMonthFor(all, year, { including: draft.ref.id });
        if (t.onPayrolls > t.entitlement) throw new PayrollError("thirteenth-over", `The 13th month pay for ${year} is more than what's earned (${peso(t.entitlement)} = 1/12 of ${peso(t.basicPay)}). Attendance changed: lower or remove it first.`);
      }
    }
    const file = stored ? await prepareStorageFinalize(tx, { tenant, objectId: stored.objectId }) : null;
    const link = issueLink(tx, { db, tenant, payrollId, previousHash: null, now });
    const stamp = FieldValue.serverTimestamp();
    file?.commit({ FieldValue });
    tx.update(sRef, { payrollTouchedAt: stamp });
    tx.update(draft.ref, {
      status: "released",
      ownerPayment: "paid",
      paymentTiming: timing,
      salary: { amount: p.netPay, method: data.method, reference: data.reference, paidDate: data.paidDate, timing, releasedBy: actor, releasedAt: stamp, ...(stored ? { proof: stored } : {}) },
      receiptStatus: "awaiting",
      receiptLinkHash: link.hash,
      receiptLinkExpiresAt: link.expiresAt,
      history: append(p.history, entry(actor, `${timing === "early" ? "Early salary payment" : "Salary paid"} ${peso(p.netPay)} on ${data.paidDate} via ${SALARY_METHODS[data.method].label}${data.reference ? ` · Ref ${data.reference}` : ""}${timing === "early" ? ` (period ends ${p.periodEnd})` : ""}`)),
      revision: (p.revision || 1) + 1,
      updatedBy: actor,
      updatedAt: stamp,
    });
    // Owner-pilot simplification batch: each advance line here is a REAL
    // repayment now (its plan entry becomes "deducted"). A deduction planned
    // for this period that isn't on the payroll becomes "not taken": still
    // owed, shown to the Owner (move it or record a repayment). The salary
    // paid is never rewritten later.
    const lineFor = new Map((p.deductions || []).filter((d) => d.type === "advance").map((d) => [d.advanceId, d.amount]));
    advSnaps.forEach((s) => {
      const a = { id: s.id, ...s.data() };
      const amount = Math.min(lineFor.get(s.id) ?? 0, advanceRemaining(a));
      const here = scheduleOf(a).filter((e) => e.state === "planned" && e.periodStart === p.periodStart);
      if (!amount && !here.length) return;
      const deductedAmount = (Number.isSafeInteger(a.deductedAmount) ? a.deductedAmount : 0) + amount;
      const owedAfter = advanceRemaining({ ...a, deductedAmount });
      const plannedHere = here.reduce((t, e) => t + e.amount, 0);
      const missed = Math.min(Math.max(0, plannedHere - amount), owedAfter);
      const schedule = [
        ...scheduleOf(a).filter((e) => !here.includes(e)),
        ...(amount ? [newEntry({ start: p.periodStart, end: p.periodEnd }, amount, "applied", { payrollId })] : []),
        ...(missed ? [newEntry({ start: p.periodStart, end: p.periodEnd }, missed, "not_taken", { payrollId })] : []),
      ];
      const done = owedAfter === 0;
      tx.update(s.ref, {
        deductedAmount,
        deducted: done,
        schedule,
        ...(done ? { deductedAt: stamp } : {}),
        deductionLog: amount ? [...(Array.isArray(a.deductionLog) ? a.deductionLog : []), { payrollId, amount, periodEnd: p.periodEnd }].slice(-100) : a.deductionLog ?? [],
        history: append(a.history, entry(actor, [amount ? `Deducted ${peso(amount)} (${p.periodStart} to ${p.periodEnd}) · ${done ? "fully repaid" : `${peso(owedAfter)} left`}` : null, missed ? `${peso(missed)} planned for ${p.periodStart} to ${p.periodEnd} not taken (salary paid without it)` : null].filter(Boolean).join(" · "))),
      });
    });
    meterActivity(tx, { tenant, FieldValue, timezone: business.timezone, now, counts: { payrollsReleased: 1 } });
    return { payrollId, status: "released", netPay: p.netPay, paymentTiming: timing, receiptToken: link.token, receiptLinkExpiresAt: link.expiresAt.toISOString(), hasProof: Boolean(stored) };
  }, TX_OPTIONS);
}

// A fresh link (the previous one stops working), while receipt is awaited.
export async function newReceiptLink({ db, tenant, FieldValue, payrollId, actor, now = new Date() }) {
  const ref = payrollRef(tenant, payrollId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PayrollError("not-found", "Payroll not found");
    const p = snap.data();
    if (p.status !== "released" || p.receiptStatus !== "awaiting") throw new PayrollError("receipt-not-awaited", p.receiptStatus === "confirmed" ? "The employee already confirmed receipt" : "Pay the salary first");
    const link = issueLink(tx, { db, tenant, payrollId, previousHash: p.receiptLinkHash, now });
    tx.update(ref, { receiptLinkHash: link.hash, receiptLinkExpiresAt: link.expiresAt, history: append(p.history, entry(actor, "New receipt link issued")), updatedAt: FieldValue.serverTimestamp() });
    return { payrollId, receiptToken: link.token, receiptLinkExpiresAt: link.expiresAt.toISOString() };
  }, TX_OPTIONS);
}

// ---------- Public receipt confirmation (no login) ----------

const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const NOT_VALID = () => new PayrollError("link-invalid", "This link isn't valid. Ask your employer for a new one.");

async function linkState(tx, db, token, now) {
  if (typeof token !== "string" || !TOKEN.test(token)) throw NOT_VALID();
  const linkRef = db.collection("receiptLinks").doc(hashToken(token));
  const linkSnap = await tx.get(linkRef);
  if (!linkSnap.exists) throw NOT_VALID();
  const link = linkSnap.data();
  const tenantRoot = db.collection("businesses").doc(link.businessId);
  const [bizSnap, paySnap] = await Promise.all([tx.get(tenantRoot), tx.get(tenantRoot.collection("payrolls").doc(link.payrollId))]);
  if (!bizSnap.exists || !paySnap.exists) throw NOT_VALID();
  const p = paySnap.data();
  if (p.receiptLinkHash !== linkSnap.id) throw NOT_VALID(); // replaced by a newer link
  const expires = link.expiresAt instanceof Date ? link.expiresAt : link.expiresAt?.toDate?.();
  return { linkRef, link, payRef: paySnap.ref, p, business: bizSnap.data(), expired: !expires || expires.getTime() < now.getTime() };
}

// Only what the employee needs to recognise the payment: no ids, no other
// records, nothing about the business beyond its name.
const publicView = ({ p, business, expired }) => ({
  businessName: business.name || "",
  employeeName: p.staffName,
  period: { start: p.periodStart, end: p.periodEnd },
  amount: p.salary?.amount ?? p.netPay,
  method: SALARY_METHODS[p.salary?.method]?.label ?? null,
  paidDate: p.salary?.paidDate ?? null,
  receiptStatus: p.receiptStatus,
  expired: p.receiptStatus === "awaiting" && expired,
});

export async function readReceiptLink({ db, token, now = new Date() }) {
  return db.runTransaction(async (tx) => publicView(await linkState(tx, db, token, now)));
}

export async function confirmReceipt({ db, FieldValue, token, now = new Date() }) {
  return db.runTransaction(async (tx) => {
    const s = await linkState(tx, db, token, now);
    if (s.p.receiptStatus === "confirmed") return { ...publicView(s), alreadyConfirmed: true };
    if (s.expired) throw new PayrollError("link-expired", "This link has expired. Ask your employer for a new one.");
    if (s.link.usedAt) throw NOT_VALID();
    const tenant = tenantDb(db, s.link.businessId);
    const notes = await prepareNotifications(tx, {
      tenant,
      events: [{ type: "payroll.receipt_confirmed", key: s.payRef.id, title: "Salary receipt confirmed", message: `${s.p.staffName} confirmed receiving ${peso(s.p.salary?.amount ?? s.p.netPay)} for ${s.p.periodStart} to ${s.p.periodEnd}.`, recordType: "payroll", recordId: s.payRef.id }],
    });
    const stamp = FieldValue.serverTimestamp();
    // Attributed to the employee, through the secure link (there is no Luna user).
    tx.update(s.payRef, { receiptStatus: "confirmed", receiptConfirmedAt: stamp, receiptConfirmedVia: "employee-link", history: append(s.p.history, entry(null, `${s.p.staffName} confirmed receipt`, { via: "employee-link" })), updatedAt: stamp });
    tx.update(s.linkRef, { usedAt: stamp });
    notes.commit({ FieldValue });
    return { ...publicView({ ...s, p: { ...s.p, receiptStatus: "confirmed" } }), confirmed: true };
  }, TX_OPTIONS);
}

export { PayrollError, isPeriodOf };

// ---------- Phase 18.6: staff self-service requests ----------
//
// A household staff member's account is linked to ONE householdStaff record
// (member.staffId, set by the server when the owner creates the login). Every
// self-service call takes the staffId from that link, never from the request.
// Requests never change attendance or payroll: only the owner's approval
// does, through the same write as the owner's own marking.

// Owner-pilot batch: notification copy in plain words, e.g.
//   Attendance request · "Yanie submitted 6 days for Oct 1–6. 4 Present, 1 Absent, 1 Paid Leave."
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}`;
export const dayRange = (a, b) => (a === b ? md(a) : a.slice(0, 7) === b.slice(0, 7) ? `${md(a)}–${Number(b.slice(8))}` : `${md(a)} – ${md(b)}`);
export function requestNotice(name, days) {
  const sorted = [...days].sort((x, y) => (x.date < y.date ? -1 : 1));
  const counts = {};
  for (const d of sorted) counts[d.status] = (counts[d.status] || 0) + 1;
  const leaveOnly = sorted.every((d) => d.status === "official_leave" || d.status === "unpaid_leave");
  const title = leaveOnly ? "Leave request" : "Attendance request";
  if (sorted.length === 1) return { title, message: `${name} asked for ${statusLabel(sorted[0].status)} on ${md(sorted[0].date)}.` };
  return { title, message: `${name} submitted ${sorted.length} days for ${dayRange(sorted[0].date, sorted.at(-1).date)}. ${Object.entries(counts).map(([k, n]) => `${n} ${statusLabel(k)}`).join(", ")}.` };
}

const requestRef = (tenant, staffId, date) => tenant.doc("attendanceRequests", attendanceId(staffId, date));
const linkedStaff = (staffId) => {
  if (!isValidStaffId(staffId)) throw new PayrollError("not-linked", "Your account isn't linked to a staff record. Ask your employer.");
  return staffId;
};

// Staff: "I was present", "Paid leave on the 24th", "Rest day"... One open
// request per person per day (a new one replaces a pending one).
export async function submitAttendanceRequest({ db, tenant, FieldValue, business, staffId, input, actor, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  const data = validateAttendanceRequest(input, { today });
  const id = linkedStaff(staffId);
  const rRef = requestRef(tenant, id, data.date);
  return db.runTransaction(async (tx) => {
    const staff = await loadStaff(tx, tenant, id);
    if (staff.status !== "active") throw new PayrollError("inactive-staff", "Your staff record is inactive. Ask your employer.");
    if (staff.startDate && data.date < staff.startDate) throw new PayrollError("invalid-date", `You started on ${staff.startDate}`);
    if (staff.endDate && data.date > staff.endDate) throw new PayrollError("invalid-date", `Your last day was ${staff.endDate}`);
    const period = staffPeriod(staff, data.date);
    const [rSnap, lineSnap, paySnap] = await Promise.all([tx.get(rRef), tx.get(tenant.doc("attendance", attendanceId(id, data.date))), tx.get(tenant.doc("payrolls", payrollIdOf(id, period.start)))]);
    if (paySnap.exists && paidPayrollLocks(paySnap.data(), data.date)) throw new PayrollError("payroll-released", "That day is in a salary that's already paid. Ask your employer.");
    const prev = rSnap.exists ? rSnap.data() : null;
    const line = lineSnap.exists ? lineSnap.data() : null;
    if (prev?.state === "pending" && prev.status === data.status && (prev.note ?? null) === data.note) return { requestId: rRef.id, state: "pending", unchanged: true };
    if (line && line.status === data.status && prev?.state !== "pending") return { requestId: rRef.id, state: "approved", unchanged: true, alreadyRecorded: true };
    const revision = (prev?.revision || 0) + 1;
    const notes = await prepareNotifications(tx, {
      tenant,
      actor,
      events: [{ type: "household.attendance_request", key: `${rRef.id}-${revision}`, ...requestNotice(staff.name, [data]), ...(data.note ? { message: `${requestNotice(staff.name, [data]).message} Note: ${data.note}` } : {}), recordType: "attendanceRequest", recordId: rRef.id }],
    });
    const stamp = FieldValue.serverTimestamp();
    tx.set(rRef, {
      schemaVersion: PAYROLL_SCHEMA_VERSION,
      staffId: id,
      staffName: staff.name,
      date: data.date,
      status: data.status,
      note: data.note,
      state: "pending",
      current: line?.status ?? null,
      submittedBy: actor,
      submittedAt: stamp,
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      history: append(prev?.history, entry(actor, `Asked for ${statusLabel(data.status)}${prev?.state === "pending" ? ` (replaces ${statusLabel(prev.status)})` : ""}`)),
      revision,
      updatedAt: stamp,
    });
    notes.commit({ FieldValue, actor });
    return { requestId: rRef.id, state: "pending" };
  }, TX_OPTIONS);
}

// Owner-pilot polish: the staff member's pay-period sheet, several days in
// ONE transaction (all or nothing: if any day isn't allowed, nothing is
// sent and every refused day is named). Per day, the same rules as above:
//   - a day the employer already approved is never overwritten (same status
//     = unchanged; a different one is refused: the employer corrects it);
//   - a pending day is replaced by the new status (same status = unchanged);
//   - a rejected day can be sent again (a new revision of that request).
// Retrying the same submission changes nothing (no duplicate history). One
// notification for the whole submission.
export async function submitAttendanceDays({ db, tenant, FieldValue, business, staffId, input, actor, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  const { days, note } = validateAttendanceDays(input, { today });
  const id = linkedStaff(staffId);
  return db.runTransaction(async (tx) => {
    const staff = await loadStaff(tx, tenant, id);
    if (staff.status !== "active") throw new PayrollError("inactive-staff", "Your staff record is inactive. Ask your employer.");
    const periodStarts = [...new Set(days.map((d) => staffPeriod(staff, d.date).start))];
    const [reqSnaps, lineSnaps, paySnaps] = await Promise.all([
      Promise.all(days.map((d) => tx.get(requestRef(tenant, id, d.date)))),
      Promise.all(days.map((d) => tx.get(tenant.doc("attendance", attendanceId(id, d.date))))),
      Promise.all(periodStarts.map((p) => tx.get(tenant.doc("payrolls", payrollIdOf(id, p))))),
    ]);
    const payrollOf = new Map(periodStarts.map((p, i) => [p, paySnaps[i].exists ? paySnaps[i].data() : null]));
    const refused = [];
    const writes = [];
    let unchanged = 0;
    days.forEach((d, i) => {
      const prev = reqSnaps[i].exists ? reqSnaps[i].data() : null;
      const line = lineSnaps[i].exists ? lineSnaps[i].data() : null;
      const pending = prev?.state === "pending";
      if (line && !pending && line.status === d.status) return void unchanged++;
      if (pending && prev.status === d.status && (prev.note ?? null) === note) return void unchanged++;
      const lock = selfDayLock({ staff, date: d.date, today, recorded: Boolean(line) && !pending, paid: paidPayrollLocks(payrollOf.get(staffPeriod(staff, d.date).start), d.date) });
      if (lock) return void refused.push(`${d.date}: ${lock}`);
      writes.push({ d, ref: reqSnaps[i].ref, prev, line });
    });
    if (refused.length) throw new PayrollError("days-not-allowed", `Nothing was sent. ${refused.join("; ")}.`);
    if (!writes.length) return { sent: 0, unchanged };
    const first = writes[0].d.date;
    const last = writes[writes.length - 1].d.date;
    const notes = await prepareNotifications(tx, {
      tenant,
      actor,
      events: [{ type: "household.attendance_request", key: `${id}_${first}_${last}_${writes.map((w) => `${w.d.date.slice(8)}${w.d.status[0]}${(w.prev?.revision || 0) + 1}`).join("")}`.slice(0, 200), ...requestNotice(staff.name, writes.map((w) => w.d)), ...(note ? { message: `${requestNotice(staff.name, writes.map((w) => w.d)).message} Note: ${note}` } : {}), recordType: "attendanceRequest", recordId: `${id}_${first}` }],
    });
    const stamp = FieldValue.serverTimestamp();
    for (const { d, ref, prev, line } of writes) {
      tx.set(ref, {
        schemaVersion: PAYROLL_SCHEMA_VERSION,
        staffId: id,
        staffName: staff.name,
        date: d.date,
        status: d.status,
        note,
        state: "pending",
        current: line?.status ?? null,
        submittedBy: actor,
        submittedAt: stamp,
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
        history: append(prev?.history, entry(actor, `Asked for ${statusLabel(d.status)}${prev?.state === "pending" ? ` (replaces ${statusLabel(prev.status)})` : prev?.state === "rejected" ? " (sent again)" : ""}`)),
        revision: (prev?.revision || 0) + 1,
        updatedAt: stamp,
      });
    }
    notes.commit({ FieldValue, actor });
    return { sent: writes.length, unchanged };
  }, TX_OPTIONS);
}

// Owner: several requests at once ("Approve all" for a person's period).
// Each day is decided in its own transaction, exactly like a single
// decision (per-day history and payroll update); the result lists any day
// that couldn't be decided.
export async function decideAttendanceRequests({ db, tenant, FieldValue, requestIds, decision, actor }) {
  if (!Array.isArray(requestIds) || !requestIds.length || requestIds.length > 62 || new Set(requestIds).size !== requestIds.length) throw new PayrollError("invalid-input", "Choose the requests");
  validateDecision(decision);
  const decided = [];
  const failed = [];
  for (const requestId of requestIds) {
    try {
      decided.push((await decideAttendanceRequest({ db, tenant, FieldValue, requestId, decision, actor })).requestId);
    } catch (err) {
      if (!(err instanceof PayrollError)) throw err;
      failed.push({ requestId, error: err.message });
    }
  }
  return { decided, failed };
}

// Owner: approve (the day is marked exactly as asked, in the same
// transaction) or reject (nothing changes). Only a pending request.
export async function decideAttendanceRequest({ db, tenant, FieldValue, requestId, decision, actor }) {
  const d = validateDecision(decision);
  const m = /^([A-Za-z0-9]{8,40})_(\d{4}-\d{2}-\d{2})$/.exec(typeof requestId === "string" ? requestId : "");
  if (!m) throw new PayrollError("invalid-request", "Invalid request");
  const rRef = requestRef(tenant, m[1], m[2]);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(rRef);
    if (!snap.exists) throw new PayrollError("not-found", "Request not found");
    const r = snap.data();
    if (r.state !== "pending") throw new PayrollError("request-decided", `This request was already ${r.state}`);
    let result = null;
    if (d.decision === "approve") {
      const plan = await prepareAttendanceWrite(tx, { tenant, staffId: r.staffId, date: r.date });
      result = plan.commit({ FieldValue, status: r.status, note: r.note ?? null, actor, via: `${r.staffName}'s request, approved` });
    }
    const stamp = FieldValue.serverTimestamp();
    tx.update(rRef, { state: d.decision === "approve" ? "approved" : "rejected", decidedBy: actor, decidedAt: stamp, decisionNote: d.note, history: append(r.history, entry(actor, `${d.decision === "approve" ? "Approved" : "Rejected"}${d.note ? ` · ${d.note}` : ""}`)), revision: (r.revision || 1) + 1, updatedAt: stamp });
    return { requestId, state: d.decision === "approve" ? "approved" : "rejected", ...(result ? { payable: result.payable ?? null } : {}) };
  }, TX_OPTIONS);
}

// Staff: ask for a cash advance. It's only a request until the owner
// approves it (and money moves only when it's released).
export async function requestAdvance({ db, tenant, FieldValue, business, staffId, input, actor, now = new Date() }) {
  const data = validateAdvanceRequest(input);
  const id = linkedStaff(staffId);
  const ref = tenant.collection("advances").doc();
  return db.runTransaction(async (tx) => {
    const staff = await loadStaff(tx, tenant, id);
    if (staff.status !== "active") throw new PayrollError("inactive-staff", "Your staff record is inactive. Ask your employer.");
    const open = await tx.get(tenant.collection("advances").where("staffId", "==", id).where("status", "==", "requested").limit(3));
    if (open.size >= 3) throw new PayrollError("too-many-requests", "You already have 3 requests waiting. Wait for an answer first.");
    await checkAdvanceLimit(tx, tenant, staff, id, data.amount, { stage: "request" });
    const notes = await prepareNotifications(tx, {
      tenant,
      actor,
      events: [{ type: "household.advance_request", key: ref.id, title: `${staff.name} asked for a ${peso(data.amount)} advance`, message: data.reason ? `Reason: ${data.reason}` : "Waiting for your approval.", recordType: "advance", recordId: ref.id }],
    });
    const stamp = FieldValue.serverTimestamp();
    tx.create(ref, {
      schemaVersion: PAYROLL_SCHEMA_VERSION,
      staffId: id,
      staffName: staff.name,
      date: businessDate(business.timezone, now),
      description: data.reason,
      requestedAmount: data.amount,
      amount: data.amount,
      installment: null,
      status: "requested",
      requestedBy: actor,
      paidDate: null,
      method: null,
      reference: null,
      paidBy: null,
      deductionPayrollId: null,
      deducted: false,
      deductedAmount: 0,
      deductionLog: [],
      skipPayrollIds: [],
      history: [entry(actor, `Requested ${peso(data.amount)}${data.reason ? ` · ${data.reason}` : ""}`)],
      revision: 1,
      createdBy: actor,
      createdAt: stamp,
      updatedBy: actor,
      updatedAt: stamp,
    });
    tx.update(staffRef(tenant, id), { advanceTouchedAt: stamp });
    notes.commit({ FieldValue, actor });
    return { advanceId: ref.id, status: "requested" };
  }, TX_OPTIONS);
}

// Owner: approve (amount may differ from the request; set the amount per
// payroll) or reject. Approval is NOT the money: "Mark released" is.
export async function decideAdvanceRequest({ db, tenant, FieldValue, advanceId, decision, approval = {}, actor }) {
  const d = validateDecision(decision);
  const ref = advanceRef(tenant, advanceId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PayrollError("not-found", "Advance not found");
    const a = snap.data();
    if (a.status !== "requested") throw new PayrollError("request-decided", "This request was already answered");
    const stamp = FieldValue.serverTimestamp();
    if (d.decision === "reject") {
      tx.update(ref, { status: "rejected", decision: { by: actor, note: d.note }, history: append(a.history, entry(actor, `Rejected${d.note ? ` · ${d.note}` : ""}`)), revision: (a.revision || 1) + 1, updatedBy: actor, updatedAt: stamp });
      return { advanceId, status: "rejected" };
    }
    const ok = validateAdvanceApproval(approval || {}, a.requestedAmount ?? a.amount);
    // The limit is checked again now: a request doesn't hold room forever.
    const staff = await loadStaff(tx, tenant, a.staffId);
    await checkAdvanceLimit(tx, tenant, staff, a.staffId, ok.amount, { stage: "approve", exclude: advanceId });
    tx.update(staffRef(tenant, a.staffId), { advanceTouchedAt: stamp });
    const asked = a.requestedAmount ?? a.amount;
    const label = `Approved ${peso(ok.amount)}${ok.amount !== asked ? ` (asked ${peso(asked)})` : ""}${ok.installment ? ` · ${peso(ok.installment)} per payroll` : " · deducted all at once"}${ok.note || d.note ? ` · ${ok.note || d.note}` : ""}`;
    tx.update(ref, { status: "not_yet_paid", amount: ok.amount, installment: ok.installment, decision: { by: actor, note: ok.note || d.note }, history: append(a.history, entry(actor, label)), revision: (a.revision || 1) + 1, updatedBy: actor, updatedAt: stamp });
    return { advanceId, status: "not_yet_paid", amount: ok.amount, installment: ok.installment };
  }, TX_OPTIONS);
}

export { validateInstallment, ADVANCE_STATUSES };

// ---------- Phase 18.6: payroll additions (Bonus, 13th Month Pay) ----------
//
// Gross = basic pay + additions; Net = Gross - deductions (payTotals).
//   bonus       discretionary: any amount the Owner gives
//   thirteenth  13th Month Pay (PD 851 as applied to kasambahay by RA 10361
//               Sec. 25): 1/12 of the BASIC pay earned in the calendar year.
//               Basic pay = Luna's basePay (paid days x daily wage, paid
//               leave included); bonuses and 13th month itself are not
//               basic pay. A payroll's year is its period-end year. Can be
//               paid in parts (e.g. half in June, the rest in December);
//               never more than what's still owed for that year.
// Serialization: adding / removing an addition and releasing a salary all
// write the staff document, so two payrolls can't both claim the same
// remaining 13th month.

export const thirteenthYearOf = (p) => Number(String(p.periodEnd || p.periodStart).slice(0, 4));

// From a person's payrolls: the year's basic pay counted (released ones,
// plus `including`, a draft about to be paid), its 13th month entitlement
// (1/12, rounded down to the centavo), what's already on payrolls
// (released + other drafts), and what's left.
export function thirteenthMonthFor(payrolls, year, { including = null, exceptPayrollId = null } = {}) {
  let basic = 0;
  let given = 0;
  let givenPaid = 0;
  for (const p of payrolls) {
    if (thirteenthYearOf(p) === year && (p.status === "released" || (including && p.id === including))) basic += Number.isSafeInteger(p.basePay) ? p.basePay : 0;
    for (const a of p.additions || []) {
      if (a.type !== "thirteenth" || a.year !== year || p.id === exceptPayrollId) continue;
      given += a.amount;
      if (p.status === "released") givenPaid += a.amount;
    }
  }
  const entitlement = Math.floor(basic / 12);
  return { year, basicPay: basic, entitlement, onPayrolls: given, paid: givenPaid, remaining: Math.max(0, entitlement - given) };
}

async function staffPayrolls(tx, tenant, staffId) {
  return (await tx.get(tenant.collection("payrolls").where("staffId", "==", staffId))).docs.map((d) => ({ id: d.id, ...d.data() }));
}

const ADDITION_TYPES = { bonus: "Bonus", thirteenth: "13th Month Pay" };
const MAX_ADDITIONS = 20;

export async function addAddition({ db, tenant, FieldValue, payrollId, addition, actor }) {
  if (!addition || typeof addition !== "object" || Array.isArray(addition)) throw new PayrollError("invalid-input", "Invalid addition");
  for (const k of Object.keys(addition)) if (!["type", "description", "amount", "year"].includes(k)) throw new PayrollError("invalid-input", `Unknown field ${k}`);
  if (!ADDITION_TYPES[addition.type]) throw new PayrollError("invalid-input", "Choose Bonus or 13th Month Pay");
  const description = typeof addition.description === "string" ? addition.description.trim().replace(/\s+/g, " ").slice(0, 120) : "";
  if (addition.amount !== undefined && (!Number.isSafeInteger(addition.amount) || addition.amount <= 0)) throw new PayrollError("invalid-amount", "The amount must be more than ₱0");
  if (addition.type === "bonus" && addition.amount === undefined) throw new PayrollError("invalid-amount", "Enter the bonus amount");
  return db.runTransaction(async (tx) => {
    const draft = await loadDraft(tx, tenant, payrollId);
    const sRef = staffRef(tenant, draft.p.staffId);
    await loadStaff(tx, tenant, draft.p.staffId);
    const list = draft.p.additions || [];
    if (list.length >= MAX_ADDITIONS) throw new PayrollError("too-many-deductions", "Too many additions on this payroll");
    let line;
    if (addition.type === "thirteenth") {
      const year = addition.year ?? thirteenthYearOf(draft.p);
      if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) throw new PayrollError("invalid-input", "Invalid year");
      const t = thirteenthMonthFor(await staffPayrolls(tx, tenant, draft.p.staffId), year, { including: draft.ref.id });
      if (t.remaining <= 0) throw new PayrollError("thirteenth-over", `No 13th month pay is left for ${year} (${peso(t.entitlement)} earned so far, ${peso(t.onPayrolls)} already given)`);
      const amount = addition.amount ?? t.remaining;
      if (amount > t.remaining) throw new PayrollError("thirteenth-over", `Only ${peso(t.remaining)} of ${year}'s 13th month pay is left (1/12 of ${peso(t.basicPay)} basic pay, minus ${peso(t.onPayrolls)} already given)`);
      line = { id: `thm-${randomBytes(6).toString("hex")}`, type: "thirteenth", year, description: description || `13th Month Pay ${year}`, amount, basis: { basicPay: t.basicPay, entitlement: t.entitlement } };
    } else {
      line = { id: `bon-${randomBytes(6).toString("hex")}`, type: "bonus", description: description || "Bonus", amount: addition.amount };
    }
    const additions = [...list, line];
    const total = additions.reduce((t, a) => t + a.amount, 0);
    const stamp = FieldValue.serverTimestamp();
    tx.update(draft.ref, { additions, ...payTotals(draft.p, { additionsTotal: total }), history: append(draft.p.history, entry(actor, `${ADDITION_TYPES[line.type]} added ${peso(line.amount)}${line.description && line.description !== ADDITION_TYPES[line.type] ? ` (${line.description})` : ""}`)), revision: (draft.p.revision || 1) + 1, updatedBy: actor, updatedAt: stamp });
    tx.update(sRef, { payrollTouchedAt: stamp });
    return { payrollId, additionId: line.id, amount: line.amount };
  }, TX_OPTIONS);
}

export async function removeAddition({ db, tenant, FieldValue, payrollId, additionId, actor }) {
  return db.runTransaction(async (tx) => {
    const draft = await loadDraft(tx, tenant, payrollId);
    const sRef = staffRef(tenant, draft.p.staffId);
    await loadStaff(tx, tenant, draft.p.staffId);
    const list = draft.p.additions || [];
    const a = list.find((x) => x.id === additionId);
    if (!a) throw new PayrollError("not-found", "Addition not found");
    const additions = list.filter((x) => x.id !== additionId);
    const stamp = FieldValue.serverTimestamp();
    tx.update(draft.ref, { additions, ...payTotals(draft.p, { additionsTotal: additions.reduce((t, x) => t + x.amount, 0) }), history: append(draft.p.history, entry(actor, `${ADDITION_TYPES[a.type]} removed ${peso(a.amount)}`)), revision: (draft.p.revision || 1) + 1, updatedBy: actor, updatedAt: stamp });
    tx.update(sRef, { payrollTouchedAt: stamp });
    return { payrollId };
  }, TX_OPTIONS);
}

// The year's 13th month for one person (Payroll screen, exports).
export async function thirteenthMonthSummary({ db, tenant, staffId, year }) {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) throw new PayrollError("invalid-input", "Invalid year");
  const snap = await tenant.collection("payrolls").where("staffId", "==", isValidStaffId(staffId) ? staffId : "-").get();
  const t = thirteenthMonthFor(snap.docs.map((d) => ({ id: d.id, ...d.data() })), year);
  return { staffId, ...t, payouts: snap.docs.flatMap((d) => (d.data().additions || []).filter((a) => a.type === "thirteenth" && a.year === year).map((a) => ({ payrollId: d.id, amount: a.amount, released: d.data().status === "released", period: { start: d.data().periodStart, end: d.data().periodEnd } }))) };
}

// ---------- Phase 18.6: salary payment proof and disputes ----------

const SALARY_PROOF_PREFIX = (businessId) => `tenants/${businessId}/payroll/proofs/`;

// Owner-pilot simplification batch: a proof may also be a PDF (bank
// transfer receipt). Images go through the payments decoder (type sniffed);
// a PDF is recognised by its own header, same size limit.
const PROOF_PDF_MAX = 2_500_000;
export function decodePayrollProof(proof) {
  if (proof && typeof proof === "object" && proof.contentType === "application/pdf") {
    for (const key of Object.keys(proof)) if (!["contentType", "dataBase64"].includes(key)) throw new PayrollError("invalid-input", "Invalid proof");
    if (typeof proof.dataBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(proof.dataBase64)) throw new PayrollError("invalid-input", "Invalid proof data");
    const data = Buffer.from(proof.dataBase64, "base64");
    if (!data.length || data.length > PROOF_PDF_MAX) throw new PayrollError("proof-too-large", "Proofs must be under 2.5 MB");
    if (data.subarray(0, 5).toString("latin1") !== "%PDF-") throw new PayrollError("invalid-input", "That file isn't a PDF");
    return { data, contentType: "application/pdf" };
  }
  return decodeProof(proof);
}
const PROOF_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/pdf": "pdf" };

// Reserve -> upload -> (finalized inside the caller's transaction). Same
// pipeline and storage metering as payment screenshots. Never reachable by
// URL: served only through the API to the Owner or the helper it belongs to.
async function storeProofFile({ db, bucket, tenant, FieldValue, businessId, recordType, recordId, proof, actor, now }) {
  const decoded = decodePayrollProof(proof);
  const path = `${SALARY_PROOF_PREFIX(businessId)}${recordType === "advance" ? "adv-" : ""}${recordId}-${randomBytes(4).toString("hex")}.${PROOF_EXT[decoded.contentType]}`;
  const reservation = await reserveStorage({ db, tenant, FieldValue, path, bytes: decoded.data.length, area: "payroll", recordType, recordId, now });
  try {
    await (await bucket()).file(path).save(decoded.data, { resumable: false, contentType: decoded.contentType, metadata: { metadata: { uploadedBy: actor.uid, [recordType === "advance" ? "advanceId" : "payrollId"]: recordId } } });
  } catch (err) {
    await releaseStorageReservation({ db, tenant, FieldValue, objectId: reservation.objectId }).catch(() => {});
    throw err;
  }
  return { path, contentType: decoded.contentType, size: decoded.data.length, objectId: reservation.objectId, uploadedBy: actor, uploadedAt: now };
}
const storeSalaryProof = ({ payrollId, ...rest }) => storeProofFile({ ...rest, recordType: "payroll", recordId: payrollId });
// A stored proof's bytes (callers check who may see it).
export async function readProofFile({ bucket, businessId, proof }) {
  if (!proof || typeof proof.path !== "string" || !proof.path.startsWith(SALARY_PROOF_PREFIX(businessId))) throw new PayrollError("not-found", "No proof here");
  const [data] = await (await bucket()).file(proof.path).download();
  return { contentType: proof.contentType, dataBase64: data.toString("base64") };
}
async function undoSalaryProof({ db, bucket, tenant, FieldValue, stored }) {
  try {
    await (await bucket()).file(stored.path).delete();
  } catch {
    /* the object may not exist */
  }
  await releaseStorageReservation({ db, tenant, FieldValue, objectId: stored.objectId }).catch(() => {});
}

// Proof for a salary already marked paid (GCash / bank screenshot added
// later). Doesn't change the payment or the employee's confirmation.
export async function attachSalaryProof({ db, bucket, tenant, FieldValue, businessId, payrollId, proof, actor, now = new Date() }) {
  const ref = payrollRef(tenant, payrollId);
  const first = await ref.get();
  if (!first.exists) throw new PayrollError("not-found", "Payroll not found");
  if (first.data().status !== "released") throw new PayrollError("payment-not-paid", "Mark the salary paid first");
  if (first.data().salary?.proof) throw new PayrollError("has-proof", "This salary already has a proof");
  const stored = await storeSalaryProof({ db, bucket, tenant, FieldValue, businessId, payrollId, proof, actor, now });
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const p = snap.data();
      if (p.salary?.proof) throw new PayrollError("has-proof", "This salary already has a proof");
      const file = await prepareStorageFinalize(tx, { tenant, objectId: stored.objectId });
      tx.update(ref, { "salary.proof": stored, history: append(p.history, entry(actor, "Payment proof added")), updatedAt: FieldValue.serverTimestamp() });
      file.commit({ FieldValue });
      return { payrollId, hasProof: true };
    }, TX_OPTIONS);
  } catch (err) {
    await undoSalaryProof({ db, bucket, tenant, FieldValue, stored });
    throw err;
  }
}

export async function readSalaryProof({ tenant, bucket, businessId, payrollId }) {
  const snap = await payrollRef(tenant, payrollId).get();
  const proof = snap.exists ? snap.data().salary?.proof : null;
  if (!proof) throw new PayrollError("not-found", "No proof on this salary");
  return readProofFile({ bucket, businessId, proof });
}
export async function readAdvanceProof({ tenant, bucket, businessId, advanceId }) {
  const snap = await advanceRef(tenant, advanceId).get();
  const proof = snap.exists ? snap.data().proof : null;
  if (!proof) throw new PayrollError("not-found", "No proof on this advance");
  return readProofFile({ bucket, businessId, proof });
}

// The Owner sorts out a "not received" report: paid again / found it, with
// a note. The employee can still confirm afterwards.
export async function resolveSalaryDispute({ db, tenant, FieldValue, payrollId, note, actor }) {
  const why = typeof note === "string" ? note.trim().replace(/\s+/g, " ").slice(0, 200) : "";
  if (why.length < 3) throw new PayrollError("invalid-input", "Say what happened (e.g. sent again by GCash)");
  const ref = payrollRef(tenant, payrollId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PayrollError("not-found", "Payroll not found");
    const p = snap.data();
    if (p.dispute?.state !== "open") throw new PayrollError("no-dispute", "Nothing to resolve");
    tx.update(ref, { ownerPayment: "paid", dispute: { ...p.dispute, state: "resolved", resolvedAt: new Date(), resolution: why, resolvedBy: { uid: actor.uid, name: actor.name ?? null } }, history: append(p.history, entry(actor, `Not-received report answered: ${why}`)), updatedAt: FieldValue.serverTimestamp() });
    return { payrollId, ownerPayment: "paid" };
  }, TX_OPTIONS);
}

// Owner-pilot fix: "Prepare payroll for everyone". Every staff member on
// payroll for the pay period (of their own cycle) that includes `asOf` gets
// a draft; nobody is enrolled twice and nobody outside their employment
// dates is included. Each person is prepared in their own transaction.
export async function prepareEligible({ db, tenant, FieldValue, business, asOf, actor, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  const day = asOf || today;
  if (!isDayId(day)) throw new PayrollError("invalid-date", "Choose a date");
  if (day > today) throw new PayrollError("invalid-period", "Choose today or an earlier date");
  const staff = (await tenant.collection("householdStaff").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const out = { prepared: [], existing: [], skipped: [] };
  for (const s of staff.sort((a, b) => (a.name || "").localeCompare(b.name || ""))) {
    const period = staffPeriod(s, day);
    const elig = payrollEligibility(s, period);
    if (!elig.eligible) {
      if (s.status === "active") out.skipped.push({ staffId: s.id, name: s.name, reason: elig.reason });
      continue;
    }
    const r = await preparePayroll({ db, tenant, FieldValue, business, staffId: s.id, periodStart: period.start, actor, now });
    (r.existing ? out.existing : out.prepared).push({ staffId: s.id, name: s.name, payrollId: r.payrollId, periodStart: period.start, periodEnd: period.end });
  }
  return out;
}

// ---------- Owner-pilot batch: automatic payroll periods ----------
//
// Payroll appears by itself: the Household Staff record (pay cycle,
// cutoffs, start / end dates, status) says who is paid for which period;
// nobody prepares or enrolls anyone. This view lists the periods (newest
// first, from each person's start date, about a year back at most) and, for
// one period, a row per person on payroll: their stored payroll if there is
// one (paid, or changed by the Owner: a bonus, a deduction), otherwise the
// figures worked out now from approved attendance and released advances.
// Reading stores nothing, so opening the page any number of times never
// creates a record; the first real action (pay, add a bonus...) stores the
// payroll, once (preparePayroll is keyed by person + period start).
// When people are on different cycles (e.g. 1–15 and 14 / 29), the default
// ({ current: true }) shows everyone in THEIR OWN current period, so nobody
// is hidden behind another person's dates.
const VIEW_MAX_PERIODS = 24;

export async function payrollPeriodView({ db, tenant, business, period: wanted = null, staffId = null, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  const wantsCurrent = wanted !== null && typeof wanted === "object" && wanted.current === true;
  if (wanted !== null && !wantsCurrent && (typeof wanted !== "object" || !isDayId(wanted.start) || !isDayId(wanted.end))) throw new PayrollError("invalid-period", "Invalid pay period");
  // Owner-pilot simplification batch: Employee filter = one helper's periods.
  const staff = (await tenant.collection("householdStaff").get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => !staffId || s.id === staffId);
  const floor = addDays(today, -366);
  const options = new Map();
  for (const s of staff) {
    const from = [s.startDate, floor].filter(Boolean).sort().pop();
    const to = s.endDate && s.endDate < today ? s.endDate : today;
    let list = [];
    try {
      list = staffPeriods(s, from, to, VIEW_MAX_PERIODS);
    } catch {
      continue; // an unknown pay cycle
    }
    for (const p of list) {
      if (!payrollEligibility(s, p).eligible) continue;
      const key = `${p.start}_${p.end}`;
      if (!options.has(key)) options.set(key, { start: p.start, end: p.end, people: 0, current: p.start <= today && today <= p.end });
      options.get(key).people += 1;
    }
  }
  const periods = [...options.values()].sort((a, b) => (a.end !== b.end ? (a.end < b.end ? 1 : -1) : a.start < b.start ? 1 : -1)).slice(0, VIEW_MAX_PERIODS);
  const currents = periods.filter((p) => p.current);
  const listed = periods.map((p) => ({ start: p.start, end: p.end, current: p.current }));
  const exact = wanted && !wantsCurrent ? periods.find((p) => p.start === wanted.start && p.end === wanted.end) : null;
  // Everyone's own current period (several cycles at once).
  if (!exact && currents.length > 1) {
    const people = staff.flatMap((s) => {
      const p = currents.find((c) => {
        try {
          const own = staffPeriod(s, c.start);
          return own.start === c.start && own.end === c.end && payrollEligibility(s, own).eligible;
        } catch {
          return false;
        }
      });
      return p ? [{ s, period: { start: p.start, end: p.end } }] : [];
    });
    const rows = await Promise.all(people.map(({ s, period }) => periodRow({ db, tenant, s, period })));
    rows.sort((a, b) => (a.staffName || "").localeCompare(b.staffName || ""));
    const start = currents.map((c) => c.start).sort()[0];
    const end = currents.map((c) => c.end).sort().at(-1);
    return { today, periods: listed, period: { start, end, state: "in_progress", mixed: true }, rows };
  }
  const pick = exact || currents[0] || periods[0] || null;
  if (!pick) return { today, periods: [], period: null, rows: [] };
  const period = { start: pick.start, end: pick.end };
  const people = staff.filter((s) => {
    try {
      const p = staffPeriod(s, period.start);
      return p.start === period.start && p.end === period.end && payrollEligibility(s, period).eligible;
    } catch {
      return false;
    }
  });
  const rows = await Promise.all(people.map((s) => periodRow({ db, tenant, s, period })));
  rows.sort((a, b) => (a.staffName || "").localeCompare(b.staffName || ""));
  return { today, periods: listed, period: { ...period, state: today <= period.end ? "in_progress" : "ended" }, rows };
}

// One person's payroll for one period: stored, or worked out now.
// Owner-pilot simplification batch: plus any deduction planned for this
// period that the paid salary didn't take ("not taken": still owed).
async function periodRow({ db, tenant, s, period }) {
  const days = daysIn(period);
  const id = payrollIdOf(s.id, period.start);
  const [snap, advSnap] = await Promise.all([tenant.doc("payrolls", id).get(), tenant.collection("advances").where("staffId", "==", s.id).where("status", "==", "paid").get()]);
  const advances = advSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const notTaken = advances.flatMap((a) => scheduleOf(a).filter((e) => e.state === "not_taken" && e.periodStart === period.start && advanceRemaining(a) > 0).map((e) => ({ advanceId: a.id, amount: Math.min(e.amount, advanceRemaining(a)), description: `Advance ${a.paidDate || a.date}${a.description ? ` (${a.description})` : ""}` })));
  if (snap.exists) return { id, ...snap.data(), notTaken, automatic: false };
  const lineSnaps = await db.getAll(...days.map((d) => tenant.doc("attendance", attendanceId(s.id, d))));
  const fig = draftFigures({ id, period, lines: lineSnaps.filter((x) => x.exists).map((x) => x.data()), advances });
  const total = deductionsTotal(fig.deductions);
  return { id, staffId: s.id, staffName: s.name, payCycle: s.payCycle, periodStart: period.start, periodEnd: period.end, days: days.length, dailyWage: s.dailyWage, ...fig.sum, deductions: fig.deductions, deductionsTotal: total, additions: [], ...payTotals({ basePay: fig.sum.basePay, additionsTotal: 0, deductionsTotal: total }), status: "draft", ownerPayment: "not_paid", salary: null, receiptStatus: "none", history: [], notTaken, automatic: true };
}

// ---------- Owner-pilot simplification batch ----------
//
// Owner records and manages; the helper reviews and confirms.

// The Owner gives an advance directly: one step (recorded + released), the
// limit checked, an optional proof, and a repayment plan from the next
// unpaid payroll. The helper later confirms receiving it.
export async function giveAdvance({ db, bucket = null, tenant, FieldValue, business, input, proof = null, actor, now = new Date() }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PayrollError("invalid-input", "Invalid advance");
  const { method, reference, ...rest } = input;
  const today = businessDate(business.timezone, now);
  const data = validateAdvanceInput(rest, { today });
  const release = validateAdvanceRelease({ paidDate: data.date, ...(method !== undefined ? { method } : {}), ...(reference !== undefined ? { reference } : {}) }, { today });
  const ref = tenant.collection("advances").doc();
  if (proof && !bucket) throw new PayrollError("invalid-input", "Proof uploads aren't available");
  const stored = proof ? await storeProofFile({ db, bucket, tenant, FieldValue, businessId: tenant.businessId, recordType: "advance", recordId: ref.id, proof, actor, now }) : null;
  try {
    return await db.runTransaction(async (tx) => {
      const staff = await loadStaff(tx, tenant, data.staffId);
      if (staff.status !== "active") throw new PayrollError("inactive-staff", `${staff.name} is inactive`);
      await checkAdvanceLimit(tx, tenant, staff, data.staffId, data.amount, { stage: "release" });
      const payrolls = await staffPayrolls(tx, tenant, data.staffId);
      const all = (await tx.get(tenant.collection("advances").where("staffId", "==", data.staffId))).docs.map((d) => ({ id: d.id, ...d.data() }));
      const file = stored ? await prepareStorageFinalize(tx, { tenant, objectId: stored.objectId }) : null;
      const base = { id: ref.id, ...data, status: "paid", paidDate: release.paidDate, deductedAmount: 0 };
      const schedule = defaultSchedule(staff, payrolls, base, release.paidDate);
      const stamp = FieldValue.serverTimestamp();
      file?.commit({ FieldValue });
      tx.create(ref, { schemaVersion: PAYROLL_SCHEMA_VERSION, ...data, staffName: staff.name, status: "paid", requestedAmount: null, ...release, paidBy: actor, schedule, receipt: { state: "awaiting" }, ...(stored ? { proof: stored } : {}), deductionPayrollId: null, deducted: false, deductedAmount: 0, repaidAmount: 0, repayments: [], deductionLog: [], skipPayrollIds: [], history: [entry(actor, `Given ${peso(data.amount)} on ${release.paidDate} via ${SALARY_METHODS[release.method].label}${release.reference ? ` · Ref ${release.reference}` : ""} · deduct ${schedule.map((e) => `${peso(e.amount)} ${periodName(e)}`).join(", ")}`)], revision: 1, createdBy: actor, createdAt: stamp, updatedBy: actor, updatedAt: stamp });
      const periods = new Set(schedule.map((e) => e.periodStart));
      const advancesAfter = [...all, { ...base, schedule }];
      for (const p of payrolls) if (p.status === "draft" && periods.has(p.periodStart)) syncDraftLines(tx, tenant, p, advancesAfter, FieldValue);
      tx.update(staffRef(tenant, data.staffId), { payrollTouchedAt: stamp, advanceTouchedAt: stamp });
      return { advanceId: ref.id, status: "paid", schedule };
    }, TX_OPTIONS);
  } catch (err) {
    if (stored) await undoSalaryProof({ db, bucket, tenant, FieldValue, stored });
    throw err;
  }
}

// Proof added to an advance already given.
export async function attachAdvanceProof({ db, bucket, tenant, FieldValue, advanceId, proof, actor, now = new Date() }) {
  const ref = advanceRef(tenant, advanceId);
  const first = await ref.get();
  if (!first.exists) throw new PayrollError("not-found", "Advance not found");
  if (first.data().status !== "paid") throw new PayrollError("advance-not-approved", "Release the advance first");
  if (first.data().proof) throw new PayrollError("has-proof", "This advance already has a proof");
  const stored = await storeProofFile({ db, bucket, tenant, FieldValue, businessId: tenant.businessId, recordType: "advance", recordId: advanceId, proof, actor, now });
  try {
    return await db.runTransaction(async (tx) => {
      const a = (await tx.get(ref)).data();
      if (a.proof) throw new PayrollError("has-proof", "This advance already has a proof");
      const file = await prepareStorageFinalize(tx, { tenant, objectId: stored.objectId });
      tx.update(ref, { proof: stored, history: append(a.history, entry(actor, "Proof added")), updatedAt: FieldValue.serverTimestamp() });
      file.commit({ FieldValue });
      return { advanceId, hasProof: true };
    }, TX_OPTIONS);
  } catch (err) {
    await undoSalaryProof({ db, bucket, tenant, FieldValue, stored });
    throw err;
  }
}

// Unpaid payroll lines the Owner added: a bonus or a manual deduction can be
// edited (amount, description) until the salary is paid. Generated lines
// (basic pay, advance deductions, 13th month) are changed at their source.
export async function editPayrollLine({ db, tenant, FieldValue, payrollId, lineId, changes, actor }) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes) || Object.keys(changes).some((k) => !["amount", "description"].includes(k))) throw new PayrollError("invalid-input", "Invalid change");
  if (changes.amount !== undefined && (!Number.isSafeInteger(changes.amount) || changes.amount <= 0 || changes.amount > MAX_ADVANCE_GUARD)) throw new PayrollError("invalid-amount", "The amount must be more than ₱0");
  const description = changes.description === undefined ? undefined : typeof changes.description === "string" ? changes.description.trim().replace(/\s+/g, " ").slice(0, 120) : null;
  if (description === null || description === "") throw new PayrollError("invalid-input", "Description is required");
  return db.runTransaction(async (tx) => {
    const draft = await loadDraft(tx, tenant, payrollId);
    const p = draft.p;
    const addIdx = (p.additions || []).findIndex((x) => x.id === lineId);
    const dedIdx = (p.deductions || []).findIndex((x) => x.id === lineId);
    const stamp = FieldValue.serverTimestamp();
    if (addIdx >= 0) {
      const before = p.additions[addIdx];
      if (before.type !== "bonus") throw new PayrollError("generated-line", "13th month pay is worked out by Luna: remove it and add it again");
      const after = { ...before, ...(changes.amount !== undefined ? { amount: changes.amount } : {}), ...(description !== undefined ? { description } : {}) };
      const additions = p.additions.map((x, i) => (i === addIdx ? after : x));
      const total = additions.reduce((t, x) => t + x.amount, 0);
      tx.update(draft.ref, { additions, ...payTotals(p, { additionsTotal: total }), history: append(p.history, entry(actor, `Bonus changed ${peso(before.amount)} → ${peso(after.amount)}${after.description !== before.description ? ` (${after.description})` : ""}`, { before: { amount: before.amount, description: before.description }, after: { amount: after.amount, description: after.description } })), revision: (p.revision || 1) + 1, updatedBy: actor, updatedAt: stamp });
      return { payrollId, lineId };
    }
    if (dedIdx >= 0) {
      const before = p.deductions[dedIdx];
      if (before.type !== "manual") throw new PayrollError("generated-line", "An advance deduction follows its repayment plan: edit the plan instead");
      const after = { ...before, ...(changes.amount !== undefined ? { amount: changes.amount } : {}), ...(description !== undefined ? { description } : {}) };
      const deductions = p.deductions.map((x, i) => (i === dedIdx ? after : x));
      const total = deductionsTotal(deductions);
      tx.update(draft.ref, { deductions, deductionsTotal: total, ...payTotals(p, { deductionsTotal: total }), history: append(p.history, entry(actor, `Deduction changed ${peso(before.amount)} → ${peso(after.amount)} (${after.description})`, { before: { amount: before.amount, description: before.description }, after: { amount: after.amount, description: after.description } })), revision: (p.revision || 1) + 1, updatedBy: actor, updatedAt: stamp });
      return { payrollId, lineId };
    }
    throw new PayrollError("not-found", "Line not found");
  }, TX_OPTIONS);
}
const MAX_ADVANCE_GUARD = 100_000_000;

// A PAID salary is never edited in place: a correction keeps the original
// payment and records what changed, why, who and when (before / after).
export async function correctPayment({ db, tenant, FieldValue, business, payrollId, correction, reason, actor, now = new Date() }) {
  const why = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ").slice(0, 200) : "";
  if (why.length < 3) throw new PayrollError("reason-required", "Say why you're correcting this payment");
  if (!correction || typeof correction !== "object" || Array.isArray(correction) || !Object.keys(correction).length || Object.keys(correction).some((k) => !["paidDate", "method", "reference", "amount"].includes(k))) throw new PayrollError("invalid-input", "Choose what to correct");
  const today = businessDate(business.timezone, now);
  if (correction.paidDate !== undefined && (!isDayId(correction.paidDate) || correction.paidDate > today)) throw new PayrollError("invalid-date", "The paid date can't be in the future");
  if (correction.method !== undefined && !SALARY_METHODS[correction.method]) throw new PayrollError("invalid-input", "Choose how the salary was paid");
  if (correction.amount !== undefined && (!Number.isSafeInteger(correction.amount) || correction.amount <= 0)) throw new PayrollError("invalid-amount", "The amount must be more than ₱0");
  const ref = payrollRef(tenant, payrollId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PayrollError("not-found", "Payroll not found");
    const p = snap.data();
    if (p.status !== "released" || !p.salary) throw new PayrollError("payment-not-paid", "Only a paid salary can be corrected");
    const before = { paidDate: p.salary.paidDate, method: p.salary.method, reference: p.salary.reference ?? null, amount: p.salary.amount };
    const after = { ...before, ...Object.fromEntries(Object.entries(correction).map(([k, v]) => [k, k === "reference" ? (typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : null) : v])) };
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    if (!changed.length) return { payrollId, unchanged: true };
    const timing = after.paidDate < p.periodEnd ? "early" : "on_time";
    const corrections = [...(Array.isArray(p.corrections) ? p.corrections : []), { at: new Date(), actor: actor ? { uid: actor.uid, name: actor.name } : null, reason: why, before, after }].slice(-50);
    const show = (k, v) => (k === "amount" ? peso(v) : k === "method" ? SALARY_METHODS[v]?.label ?? v : v ?? "—");
    tx.update(ref, { "salary.paidDate": after.paidDate, "salary.method": after.method, "salary.reference": after.reference, "salary.amount": after.amount, "salary.timing": timing, paymentTiming: timing, corrections, history: append(p.history, entry(actor, `Payment corrected: ${changed.map((k) => `${k} ${show(k, before[k])} → ${show(k, after[k])}`).join(", ")} · Reason: ${why}`, { before, after, reason: why })), updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
    return { payrollId, corrected: changed };
  }, TX_OPTIONS);
}

// The Owner marks several days for one helper at once (the attendance
// sheet). Each day is its own write with its own history, exactly like one
// day; the answer lists any day that couldn't be saved.
export async function setAttendanceMany({ db, tenant, FieldValue, business, staffId, days, reason = null, actor, now = new Date() }) {
  if (!isValidStaffId(staffId)) throw new PayrollError("invalid-staff", "Choose a staff member");
  if (!Array.isArray(days) || !days.length || days.length > 31) throw new PayrollError("invalid-input", "Choose up to 31 days");
  const seen = new Set();
  for (const d of days) {
    if (!d || typeof d !== "object" || Array.isArray(d) || Object.keys(d).some((k) => !["date", "status"].includes(k)) || seen.has(d.date)) throw new PayrollError("invalid-input", "Invalid day");
    seen.add(d.date);
  }
  const saved = [];
  const failed = [];
  for (const d of days) {
    try {
      const r = await setAttendance({ db, tenant, FieldValue, business, input: { staffId, date: d.date, status: d.status, ...(reason ? { reason } : {}) }, actor, now });
      saved.push({ date: d.date, unchanged: Boolean(r.unchanged) });
    } catch (err) {
      if (!(err instanceof PayrollError)) throw err;
      failed.push({ date: d.date, code: err.code, error: err.message });
    }
  }
  return { saved, failed };
}

// ---- What the helper confirms or reports (attendance) ----
const correctionsOf = (tenant) => tenant.collection("attendanceCorrections");
const confirmationRef = (tenant, staffId, periodStart) => tenant.doc("attendanceConfirmations", `${staffId}_${periodStart}`);
const MAX_OPEN_CORRECTIONS = 5;

// "I reviewed the attendance recorded for me" for one pay period (a snapshot
// of the counts, so the Owner sees when days changed since).
export async function confirmAttendance({ db, tenant, FieldValue, business, staffId, periodStart, actor, now = new Date() }) {
  if (!isValidStaffId(staffId)) throw new PayrollError("not-linked", "Your account isn't linked to a staff record. Ask your employer.");
  const today = businessDate(business.timezone, now);
  return db.runTransaction(async (tx) => {
    const staff = await loadStaff(tx, tenant, staffId);
    if (!isDayId(periodStart)) throw new PayrollError("invalid-date", "Invalid pay period");
    const period = staffPeriod(staff, periodStart);
    if (period.start !== periodStart) throw new PayrollError("invalid-date", "Invalid pay period");
    if (period.start > today) throw new PayrollError("invalid-date", "That pay period hasn't started yet");
    const lines = (await tx.getAll(...daysIn(period).map((d) => tenant.doc("attendance", attendanceId(staffId, d))))).filter((x) => x.exists).map((x) => x.data());
    const counts = summarizeAttendance(lines, period);
    const ref = confirmationRef(tenant, staffId, period.start);
    const prev = await tx.get(ref);
    const snapshot = { present: counts.present, absent: counts.absent, officialLeave: counts.officialLeave, unpaidLeave: counts.unpaidLeave, restDay: counts.restDay, notMarked: counts.notMarked };
    if (prev.exists && JSON.stringify(prev.data().counts) === JSON.stringify(snapshot)) return { periodStart: period.start, unchanged: true };
    const notes = await prepareNotifications(tx, {
      tenant,
      actor,
      events: [{ type: "household.attendance_confirmed", key: `${ref.id}-${(prev.data()?.revision || 0) + 1}`, title: "Attendance confirmed", message: `${staff.name} confirmed the attendance for ${dayRange(period.start, period.end)}.`, recordType: "attendanceConfirmation", recordId: ref.id }],
    });
    tx.set(ref, { staffId, staffName: staff.name, periodStart: period.start, periodEnd: period.end, counts: snapshot, confirmedAt: FieldValue.serverTimestamp(), confirmedBy: { uid: actor.uid, name: actor.name ?? null }, revision: (prev.data()?.revision || 0) + 1 });
    notes.commit({ FieldValue, actor });
    return { periodStart: period.start, confirmed: true };
  }, TX_OPTIONS);
}

// "Something is wrong": one sentence (and the day, if it's about one day).
// The Owner fixes the attendance and marks the report done.
export async function reportCorrection({ db, tenant, FieldValue, business, staffId, input, actor, now = new Date() }) {
  if (!isValidStaffId(staffId)) throw new PayrollError("not-linked", "Your account isn't linked to a staff record. Ask your employer.");
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => !["date", "message"].includes(k))) throw new PayrollError("invalid-input", "Invalid report");
  const message = typeof input.message === "string" ? input.message.trim().replace(/\s+/g, " ") : "";
  if (message.length < 3 || message.length > 300) throw new PayrollError("invalid-input", "Say what's wrong (3 to 300 characters)");
  const today = businessDate(business.timezone, now);
  const date = input.date ?? null;
  if (date !== null && (!isDayId(date) || date > addDays(today, 90))) throw new PayrollError("invalid-date", "Invalid date");
  const ref = correctionsOf(tenant).doc();
  return db.runTransaction(async (tx) => {
    const staff = await loadStaff(tx, tenant, staffId);
    const open = await tx.get(correctionsOf(tenant).where("staffId", "==", staffId).where("state", "==", "open").limit(MAX_OPEN_CORRECTIONS));
    if (open.size >= MAX_OPEN_CORRECTIONS) throw new PayrollError("too-many-requests", "You already have 5 reports waiting. Wait for your employer to look at them.");
    const notes = await prepareNotifications(tx, {
      tenant,
      actor,
      events: [{ type: "household.attendance_correction", key: ref.id, title: "Attendance correction", message: `${staff.name} reported an attendance correction${date ? ` for ${dayRange(date, date)}` : ""}: "${message.slice(0, 120)}"`, recordType: "attendanceCorrection", recordId: `${staffId}_${date || today}` }],
    });
    tx.create(ref, { staffId, staffName: staff.name, date, message, state: "open", createdAt: FieldValue.serverTimestamp(), createdBy: { uid: actor.uid, name: actor.name ?? null }, resolution: null });
    notes.commit({ FieldValue, actor });
    return { correctionId: ref.id, state: "open" };
  }, TX_OPTIONS);
}

export async function resolveCorrection({ db, tenant, FieldValue, correctionId, note = null, actor }) {
  if (typeof correctionId !== "string" || !/^[A-Za-z0-9]{8,40}$/.test(correctionId)) throw new PayrollError("invalid-input", "Invalid report");
  const why = typeof note === "string" ? note.trim().replace(/\s+/g, " ").slice(0, 200) : "";
  const ref = correctionsOf(tenant).doc(correctionId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PayrollError("not-found", "Report not found");
    if (snap.data().state !== "open") return { correctionId, unchanged: true };
    tx.update(ref, { state: "resolved", resolution: why || null, resolvedAt: FieldValue.serverTimestamp(), resolvedBy: { uid: actor.uid, name: actor.name ?? null } });
    return { correctionId, state: "resolved" };
  }, TX_OPTIONS);
}

// For the Owner's Attendance page: open reports and legacy staff requests
// (compact "Needs review"), and one helper's confirmation for one period.
export async function attendanceReview({ tenant, staffId = null, periodStart = null }) {
  const [corr, reqs] = await Promise.all([correctionsOf(tenant).where("state", "==", "open").limit(100).get(), tenant.collection("attendanceRequests").where("state", "==", "pending").limit(100).get()]);
  const corrections = corr.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString?.() ?? null })).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const requests = reqs.docs.map((d) => ({ id: d.id, ...d.data() })).map((r) => ({ id: r.id, staffId: r.staffId, staffName: r.staffName, date: r.date, status: r.status, note: r.note ?? null }));
  let confirmation = null;
  if (isValidStaffId(staffId) && isDayId(periodStart)) {
    const c = await confirmationRef(tenant, staffId, periodStart).get();
    if (c.exists) confirmation = { periodStart, counts: c.data().counts, confirmedAt: c.data().confirmedAt?.toDate?.()?.toISOString?.() ?? null };
  }
  return { corrections: corrections.map(({ id, staffId: s, staffName, date, message, createdAt }) => ({ id, staffId: s, staffName, date, message, createdAt })), requests, confirmation };
}

// ---------- Owner-pilot change: void a paid payroll / a released advance ----------
//
// Real money was recorded, so nothing is silently destroyed: the record
// moves to voidedPayrolls / voidedAdvances (with the reason, who, when and
// every reversal made) and leaves the active lists. Its proof file stays
// with the voided record (still metered; never orphaned). Retrying is fine.

const voidReason = (reason) => {
  const why = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ").slice(0, 200) : "";
  if (why.length < 3) throw new PayrollError("reason-required", "Say why (e.g. Entered twice, Wrong employee)");
  return why;
};

// A PAID payroll: the salary payment is reversed. Advance deductions it took
// go back to what's owed (planned again for that period), its days unlock,
// its receipt link stops working; the helper's confirmation and the proof
// stay in the voided record. The period then shows as unpaid again
// (worked out automatically). An UNPAID payroll is simply deleted instead.
export async function voidPayroll({ db, tenant, FieldValue, payrollId, reason, actor, now = new Date() }) {
  const why = voidReason(reason);
  const ref = payrollRef(tenant, payrollId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const done = await tx.get(tenant.collection("voidedPayrolls").where("originalId", "==", payrollId).limit(1));
      if (!done.empty) return { payrollId, voided: true, alreadyVoided: true };
      throw new PayrollError("not-found", "Payroll not found");
    }
    const p = snap.data();
    if (p.status !== "released") throw new PayrollError("payroll-unpaid", "This payroll isn't paid: delete it instead");
    await loadStaff(tx, tenant, p.staffId);
    const advSnaps = (await tx.get(tenant.collection("advances").where("staffId", "==", p.staffId))).docs;
    const lineSnaps = (await tx.get(tenant.collection("attendance").where("payrollId", "==", payrollId))).docs;
    const linkRef = p.receiptLinkHash ? db.collection("receiptLinks").doc(p.receiptLinkHash) : null;
    const linkSnap = linkRef ? await tx.get(linkRef) : null;
    const stamp = FieldValue.serverTimestamp();
    const reversals = [];
    for (const s of advSnaps) {
      const a = s.data();
      const applied = scheduleOf(a).filter((e) => e.state === "applied" && e.payrollId === payrollId);
      const missed = scheduleOf(a).filter((e) => e.state === "not_taken" && e.payrollId === payrollId);
      if (!applied.length && !missed.length) continue;
      const back = applied.reduce((t, e) => t + e.amount, 0);
      const deductedAmount = Math.max(0, (Number.isSafeInteger(a.deductedAmount) ? a.deductedAmount : 0) - back);
      const schedule = scheduleOf(a).map((e) => (applied.includes(e) || missed.includes(e) ? { ...e, state: "planned", payrollId: null } : e));
      if (back) reversals.push({ type: "advance-deduction", advanceId: s.id, amount: back });
      tx.update(s.ref, { deductedAmount, deducted: false, schedule, deductionLog: [...(Array.isArray(a.deductionLog) ? a.deductionLog : []), ...(back ? [{ payrollId, amount: -back, periodEnd: p.periodEnd, voided: true }] : [])].slice(-100), history: append(a.history, entry(actor, `${back ? `${peso(back)} deduction reversed` : "Plan restored"}: the ${p.periodStart} to ${p.periodEnd} payroll was voided (${why})`)), updatedAt: stamp });
    }
    for (const l of lineSnaps) tx.update(l.ref, { payrollId: null });
    if (lineSnaps.length) reversals.push({ type: "attendance-unlocked", days: lineSnaps.length });
    if (linkSnap?.exists) tx.delete(linkRef);
    const voidRef = tenant.collection("voidedPayrolls").doc(`${payrollId}-${now.getTime()}`);
    tx.create(voidRef, { ...p, originalId: payrollId, void: { reason: why, by: actor ? { uid: actor.uid, name: actor.name } : null, at: now, reversals, receiptWas: p.receiptStatus ?? null }, history: append(p.history, entry(actor, `Voided · Reason: ${why}`)) });
    tx.delete(ref);
    tx.update(staffRef(tenant, p.staffId), { payrollTouchedAt: stamp });
    tx.set(tenant.collection("auditLog").doc(), { type: "payroll.voided", payrollId, voidedId: voidRef.id, staffId: p.staffId, staffName: p.staffName, period: { start: p.periodStart, end: p.periodEnd }, amountPaid: p.salary?.amount ?? null, reason: why, reversals, actor, at: stamp });
    return { payrollId, voided: true, reversals };
  }, TX_OPTIONS);
}

// A RELEASED advance entered by mistake ("Entered twice", "Wrong
// employee"): what's owed on it is cancelled, its planned deductions leave
// any unpaid payroll, and separate repayments on it are reversed (listed in
// the voided record). A deduction already taken by a PAID payroll can't be
// undone here without rewriting that salary: void (or correct) that payroll
// first; Luna names it.
export async function voidAdvance({ db, tenant, FieldValue, advanceId, reason, actor, now = new Date() }) {
  const why = voidReason(reason);
  const ref = advanceRef(tenant, advanceId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const done = await tx.get(tenant.collection("voidedAdvances").doc(advanceId));
      if (done.exists) return { advanceId, voided: true, alreadyVoided: true };
      throw new PayrollError("not-found", "Advance not found");
    }
    const a = { id: snap.id, ...snap.data() };
    if (a.status !== "paid") throw new PayrollError("advance-not-released", "This advance wasn't given: delete it instead");
    const applied = scheduleOf(a).filter((e) => e.state === "applied");
    if (applied.length) throw new PayrollError("paid-payroll-deduction", `Paid salary already took ${applied.map((e) => `${peso(e.amount)} (${e.periodStart} to ${e.periodEnd})`).join(", ")} from this advance. Void that payroll first, then void the advance.`);
    await loadStaff(tx, tenant, a.staffId);
    const payrolls = await staffPayrolls(tx, tenant, a.staffId);
    const all = (await tx.get(tenant.collection("advances").where("staffId", "==", a.staffId))).docs.map((d) => ({ id: d.id, ...d.data() }));
    const stamp = FieldValue.serverTimestamp();
    const repaid = Array.isArray(a.repayments) ? a.repayments : [];
    const reversals = [
      { type: "balance-cancelled", amount: advanceRemaining(a) },
      ...(repaid.length ? [{ type: "repayments-reversed", amount: repaid.reduce((t, r) => t + r.amount, 0), count: repaid.length }] : []),
      ...(plannedEntries(a).length ? [{ type: "planned-deductions-removed", amount: plannedEntries(a).reduce((t, e) => t + e.amount, 0) }] : []),
    ];
    const touched = new Set(plannedEntries(a).map((e) => e.periodStart));
    const advancesAfter = all.filter((x) => x.id !== a.id);
    for (const p of payrolls) if (p.status === "draft" && touched.has(p.periodStart)) syncDraftLines(tx, tenant, p, advancesAfter, FieldValue);
    tx.create(tenant.collection("voidedAdvances").doc(advanceId), { ...snap.data(), originalId: advanceId, void: { reason: why, by: actor ? { uid: actor.uid, name: actor.name } : null, at: now, reversals, receiptWas: a.receipt?.state ?? null }, history: append(a.history, entry(actor, `Voided · Reason: ${why}`)) });
    tx.delete(ref);
    tx.update(staffRef(tenant, a.staffId), { payrollTouchedAt: stamp, advanceTouchedAt: stamp });
    tx.set(tenant.collection("auditLog").doc(), { type: "advance.voided", advanceId, staffId: a.staffId, staffName: a.staffName, amount: a.amount, reason: why, reversals, actor, at: stamp });
    return { advanceId, voided: true, reversals };
  }, TX_OPTIONS);
}

// The voided records, newest first (the optional "Voided records" view).
export async function listVoided({ tenant, kind, staffId = null }) {
  const col = kind === "advance" ? "voidedAdvances" : "voidedPayrolls";
  const snap = await (isValidStaffId(staffId) ? tenant.collection(col).where("staffId", "==", staffId) : tenant.collection(col)).limit(100).get();
  const iso = (v) => (v instanceof Date ? v : v?.toDate?.())?.toISOString?.() ?? null;
  return snap.docs
    .map((d) => d.data())
    .map((x) => ({ staffName: x.staffName, ...(kind === "advance" ? { amount: x.amount, date: x.paidDate || x.date } : { period: { start: x.periodStart, end: x.periodEnd }, amountPaid: x.salary?.amount ?? null }), reason: x.void?.reason ?? null, by: x.void?.by?.name ?? null, at: iso(x.void?.at), reversals: x.void?.reversals ?? [] }))
    .sort((a, b) => ((a.at || "") < (b.at || "") ? 1 : -1));
}
