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
import {
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
  validateDecision,
  validateAdvanceRequest,
  validateAdvanceApproval,
  validateInstallment,
  applyLineChange,
  advanceRemaining,
  nextDeduction,
  ADVANCE_STATUSES,
} from "../../../shared/payroll.js";
import { businessDate } from "../../../shared/metrics.js";
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
    const changed = Object.keys(data).filter((k) => (current[k] ?? null) !== (data[k] ?? null));
    if (!changed.length) return { staffId, unchanged: true };
    // A pay cycle change would orphan an unpaid payroll's period.
    if (changed.includes("payCycle")) {
      const drafts = await tx.get(tenant.collection("payrolls").where("staffId", "==", staffId).where("status", "==", "draft").limit(1));
      if (!drafts.empty) throw new PayrollError("has-draft-payroll", "Pay or delete this person's unpaid payroll before changing the pay cycle");
    }
    const labels = changed.map((k) => (k === "dailyWage" ? `Daily wage changed ${peso(current.dailyWage)} → ${peso(data.dailyWage)}` : k === "notes" ? "Notes updated" : `${k} changed`));
    tx.update(ref, { ...Object.fromEntries(changed.map((k) => [k, data[k]])), ...(changed.includes("name") ? { nameLower: lower(data.name) } : {}), history: append(current.history, entry(actor, labels.join(" · "))), revision: (current.revision || 1) + 1, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
    return { staffId };
  }, TX_OPTIONS);
}

export async function setStaffStatus({ db, tenant, FieldValue, staffId, status, actor }) {
  if (!["active", "inactive"].includes(status)) throw new PayrollError("invalid-input", "Status must be active or inactive");
  const ref = staffRef(tenant, staffId);
  return db.runTransaction(async (tx) => {
    const current = await loadStaff(tx, tenant, staffId);
    if (current.status === status) return { staffId, unchanged: true };
    tx.update(ref, { status, history: append(current.history, entry(actor, status === "active" ? "Reactivated" : "Deactivated")), revision: (current.revision || 1) + 1, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
    return { staffId, status };
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
export async function setAttendance({ db, tenant, FieldValue, business, input, actor, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  const { staffId, date, status, note } = validateAttendanceInput(input, { today });
  return db.runTransaction(async (tx) => {
    const plan = await prepareAttendanceWrite(tx, { tenant, staffId, date });
    return plan.commit({ FieldValue, status, note, actor });
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
  const period = periodFor(staff.payCycle, date);
  const pRef = tenant.doc("payrolls", payrollIdOf(staffId, period.start));
  const [lineSnap, paySnap] = await Promise.all([tx.get(lineRef), tx.get(pRef)]);
  const before = lineSnap.exists ? lineSnap.data() : null;
  const payroll = paySnap.exists ? paySnap.data() : null;
  if (payroll && payroll.status !== "draft") throw new PayrollError("payroll-released", `This day is in a payroll that's already paid (${payroll.periodStart} to ${payroll.periodEnd})`);
  return {
    staff,
    commit({ FieldValue, status, note, actor, via = null }) {
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
      history: append(before?.history, entry(actor, `${before ? `${statusLabel(before.status)} → ${statusLabel(status)}` : `Marked ${statusLabel(status)}`}${via ? ` (${via})` : ""}`, { from: before?.status ?? null, to: status })),
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
    const stamp = FieldValue.serverTimestamp();
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
    const label = [data.amount !== a.amount ? `Amount changed ${peso(a.amount)} → ${peso(data.amount)}` : null, (data.installment ?? null) !== (a.installment ?? null) ? (data.installment ? `Deduct ${peso(data.installment)} per payroll` : "Deduct all at once") : null].filter(Boolean).join(" · ") || "Advance edited";
    tx.update(ref, { date: data.date, description: data.description, amount: data.amount, installment: data.installment, history: append(a.history, entry(actor, label)), revision: (a.revision || 1) + 1, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
    return { advanceId };
  }, TX_OPTIONS);
}

export async function deleteAdvance({ db, tenant, advanceId }) {
  const ref = advanceRef(tenant, advanceId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PayrollError("not-found", "Advance not found");
    if (snap.data().status !== "not_yet_paid") throw new PayrollError("advance-paid", snap.data().status === "paid" ? "A released advance can't be deleted" : "Reject the request instead");
    tx.delete(ref);
    return { advanceId, deleted: true };
  }, TX_OPTIONS);
}

// The earliest unpaid payroll of a person (the "next payroll").
async function openDraft(tx, tenant, staffId) {
  const snap = await tx.get(tenant.collection("payrolls").where("staffId", "==", staffId).where("status", "==", "draft"));
  return snap.docs.map((d) => ({ ref: d.ref, data: d.data() })).sort((x, y) => (x.data.periodStart < y.data.periodStart ? -1 : 1))[0] || null;
}

// The advance's next deduction: its installment (or everything left).
const advanceDeduction = (advanceId, a) => {
  const amount = nextDeduction(a);
  const partial = amount < advanceRemaining(a) || advanceRemaining(a) < a.amount;
  return { id: `adv-${advanceId}`, type: "advance", advanceId, description: `Advance ${a.date}${a.description ? ` (${a.description})` : ""}${partial ? ` · ${peso(amount)} of ${peso(advanceRemaining(a))} left` : ""}`, amount };
};

// Released to the employee (Paid). From then on it's deducted in full from
// the person's next payroll: an open draft gets the deduction now.
export async function markAdvancePaid({ db, tenant, FieldValue, business, advanceId, release, actor, now = new Date() }) {
  const data = validateAdvanceRelease(release, { today: businessDate(business.timezone, now) });
  const ref = advanceRef(tenant, advanceId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PayrollError("not-found", "Advance not found");
    const a = snap.data();
    if (a.status === "paid") throw new PayrollError("advance-paid", "This advance is already marked paid");
    if (a.status !== "not_yet_paid") throw new PayrollError("advance-not-approved", a.status === "requested" ? "Approve the request first" : "A rejected request can't be released");
    const sRef = staffRef(tenant, a.staffId);
    await loadStaff(tx, tenant, a.staffId);
    const draft = await openDraft(tx, tenant, a.staffId);
    const stamp = FieldValue.serverTimestamp();
    if (draft) {
      if ((draft.data.deductions || []).length >= MAX_DEDUCTIONS_PER_PAYROLL) throw new PayrollError("too-many-deductions", "That payroll has too many deductions");
      const deductions = [...(draft.data.deductions || []), advanceDeduction(advanceId, a)];
      const total = deductionsTotal(deductions);
      tx.update(draft.ref, { deductions, deductionsTotal: total, ...payTotals(draft.data, { deductionsTotal: total }), revision: (draft.data.revision || 1) + 1, updatedAt: stamp });
    }
    tx.update(ref, { status: "paid", ...data, paidBy: actor, deductionPayrollId: draft ? draft.ref.id : null, history: append(a.history, entry(actor, `Marked paid ${data.paidDate} via ${SALARY_METHODS[data.method].label}${data.reference ? ` · Ref ${data.reference}` : ""}`)), revision: (a.revision || 1) + 1, updatedBy: actor, updatedAt: stamp });
    tx.update(sRef, { payrollTouchedAt: stamp });
    return { advanceId, status: "paid", deductionPayrollId: draft ? draft.ref.id : null };
  }, TX_OPTIONS);
}

// ---------- Payroll ----------

// Prepares (or returns) the person's payroll for the period starting on
// periodStart: counts from the attendance lines, base pay, and every paid,
// not-yet-deducted advance deducted in full. Idempotent per person+period.
export async function preparePayroll({ db, tenant, FieldValue, business, staffId, periodStart, actor, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  return db.runTransaction(async (tx) => {
    const sRef = staffRef(tenant, staffId);
    const staff = await loadStaff(tx, tenant, staffId);
    const period = periodFor(staff.payCycle, periodStart);
    if (period.start !== periodStart) throw new PayrollError("invalid-period", `A ${staff.payCycle.replace("_", "-")} period starts on ${period.start}`);
    if (period.start > today) throw new PayrollError("invalid-period", "That pay period hasn't started yet");
    const id = payrollIdOf(staffId, period.start);
    const ref = tenant.doc("payrolls", id);
    const existing = await tx.get(ref);
    if (existing.exists) return { payrollId: id, existing: true };

    const days = daysIn(period);
    const lineSnaps = await tx.getAll(...days.map((d) => tenant.doc("attendance", attendanceId(staffId, d))));
    const lines = lineSnaps.filter((s) => s.exists).map((s) => ({ ref: s.ref, ...s.data() }));
    const adv = await tx.get(tenant.collection("advances").where("staffId", "==", staffId).where("status", "==", "paid").where("deductionPayrollId", "==", null));
    const toDeduct = adv.docs.filter((d) => !(d.data().deducted === true) && advanceRemaining(d.data()) > 0 && !(d.data().skipPayrollIds || []).includes(id)).slice(0, MAX_DEDUCTIONS_PER_PAYROLL);

    const sum = summarizeAttendance(lines, period);
    const deductions = toDeduct.map((d) => advanceDeduction(d.id, d.data()));
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
    for (const d of toDeduct) tx.update(d.ref, { deductionPayrollId: id });
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
    if (d.type !== "manual") throw new PayrollError("advance-deduction", "Advances are deducted automatically; use \"Deduct next payroll\" to move one");
    withDeductions(tx, draft, list.filter((x) => x.id !== deductionId), actor, `Deduction removed ${peso(d.amount)} (${d.description})`, FieldValue);
    return { payrollId };
  }, TX_OPTIONS);
}

// Moves a paid advance's deduction to the person's NEXT payroll (e.g. when
// this period's pay can't cover it). It's still deducted in full, later.
export async function deferAdvance({ db, tenant, FieldValue, payrollId, advanceId, actor }) {
  return db.runTransaction(async (tx) => {
    const draft = await loadDraft(tx, tenant, payrollId);
    const aRef = advanceRef(tenant, advanceId);
    const aSnap = await tx.get(aRef);
    if (!aSnap.exists || aSnap.data().deductionPayrollId !== payrollId) throw new PayrollError("not-found", "That advance isn't deducted in this payroll");
    const sRef = staffRef(tenant, draft.p.staffId);
    await loadStaff(tx, tenant, draft.p.staffId);
    const a = aSnap.data();
    withDeductions(tx, draft, (draft.p.deductions || []).filter((x) => x.advanceId !== advanceId), actor, `Advance ${peso(a.amount)} moved to the next payroll`, FieldValue);
    tx.update(aRef, { deductionPayrollId: null, skipPayrollIds: [...(a.skipPayrollIds || []), payrollId], history: append(a.history, entry(actor, "Deduction moved to the next payroll")), updatedAt: FieldValue.serverTimestamp() });
    tx.update(sRef, { payrollTouchedAt: FieldValue.serverTimestamp() });
    return { payrollId, advanceId };
  }, TX_OPTIONS);
}

export async function deleteDraftPayroll({ db, tenant, FieldValue, payrollId, actor }) {
  return db.runTransaction(async (tx) => {
    const draft = await loadDraft(tx, tenant, payrollId);
    const sRef = staffRef(tenant, draft.p.staffId);
    await loadStaff(tx, tenant, draft.p.staffId);
    const adv = await tx.get(tenant.collection("advances").where("deductionPayrollId", "==", payrollId));
    const lines = await tx.get(tenant.collection("attendance").where("payrollId", "==", payrollId));
    const skipped = await tx.get(tenant.collection("advances").where("skipPayrollIds", "array-contains", payrollId));
    tx.delete(draft.ref);
    for (const d of adv.docs) tx.update(d.ref, { deductionPayrollId: null });
    for (const d of skipped.docs) tx.update(d.ref, { skipPayrollIds: (d.data().skipPayrollIds || []).filter((x) => x !== payrollId) });
    for (const l of lines.docs) tx.update(l.ref, { payrollId: null });
    tx.update(sRef, { payrollTouchedAt: FieldValue.serverTimestamp() });
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
export async function releaseSalary({ db, tenant, FieldValue, business, payrollId, release, actor, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  const data = validateSalaryRelease(release, { today });
  return db.runTransaction(async (tx) => {
    const draft = await loadDraft(tx, tenant, payrollId);
    const p = draft.p;
    if (today < p.periodEnd) throw new PayrollError("period-not-ended", `This pay period ends on ${p.periodEnd}`);
    if (p.netPay < 0) throw new PayrollError("negative-net-pay", "Deductions are more than this period's pay. Move an advance to the next payroll first.");
    const advRefs = (p.deductions || []).filter((d) => d.type === "advance").map((d) => tenant.doc("advances", d.advanceId));
    const advSnaps = advRefs.length ? await tx.getAll(...advRefs) : [];
    const link = issueLink(tx, { db, tenant, payrollId, previousHash: null, now });
    const stamp = FieldValue.serverTimestamp();
    tx.update(draft.ref, {
      status: "released",
      salary: { amount: p.netPay, method: data.method, reference: data.reference, paidDate: data.paidDate, releasedBy: actor, releasedAt: stamp },
      receiptStatus: "awaiting",
      receiptLinkHash: link.hash,
      receiptLinkExpiresAt: link.expiresAt,
      history: append(p.history, entry(actor, `Salary paid ${peso(p.netPay)} via ${SALARY_METHODS[data.method].label}${data.reference ? ` · Ref ${data.reference}` : ""}`)),
      revision: (p.revision || 1) + 1,
      updatedBy: actor,
      updatedAt: stamp,
    });
    // Each advance deducted here: add this payroll's installment; fully
    // repaid -> deducted; otherwise it waits for the next payroll.
    const lineFor = new Map((p.deductions || []).filter((d) => d.type === "advance").map((d) => [d.advanceId, d.amount]));
    advSnaps.forEach((s) => {
      if (!s.exists) return;
      const a = s.data();
      const amount = lineFor.get(s.id) ?? 0;
      const deductedAmount = (Number.isSafeInteger(a.deductedAmount) ? a.deductedAmount : 0) + amount;
      const done = deductedAmount >= a.amount;
      tx.update(s.ref, {
        deductedAmount,
        deducted: done,
        ...(done ? { deductedAt: stamp } : { deductionPayrollId: null }),
        deductionLog: [...(Array.isArray(a.deductionLog) ? a.deductionLog : []), { payrollId, amount, periodEnd: p.periodEnd }].slice(-100),
        history: append(a.history, entry(actor, done ? `Deducted ${peso(amount)} (${p.periodStart} to ${p.periodEnd}) · fully repaid` : `Deducted ${peso(amount)} (${p.periodStart} to ${p.periodEnd}) · ${peso(a.amount - deductedAmount)} left`)),
      });
    });
    meterActivity(tx, { tenant, FieldValue, timezone: business.timezone, now, counts: { payrollsReleased: 1 } });
    return { payrollId, status: "released", netPay: p.netPay, receiptToken: link.token, receiptLinkExpiresAt: link.expiresAt.toISOString() };
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
    const period = periodFor(staff.payCycle, data.date);
    const [rSnap, lineSnap, paySnap] = await Promise.all([tx.get(rRef), tx.get(tenant.doc("attendance", attendanceId(id, data.date))), tx.get(tenant.doc("payrolls", payrollIdOf(id, period.start)))]);
    if (paySnap.exists && paySnap.data().status !== "draft") throw new PayrollError("payroll-released", "That day is in a salary that's already paid. Ask your employer.");
    const prev = rSnap.exists ? rSnap.data() : null;
    const line = lineSnap.exists ? lineSnap.data() : null;
    if (prev?.state === "pending" && prev.status === data.status && (prev.note ?? null) === data.note) return { requestId: rRef.id, state: "pending", unchanged: true };
    if (line && line.status === data.status && prev?.state !== "pending") return { requestId: rRef.id, state: "approved", unchanged: true, alreadyRecorded: true };
    const revision = (prev?.revision || 0) + 1;
    const notes = await prepareNotifications(tx, {
      tenant,
      actor,
      events: [{ type: "household.attendance_request", key: `${rRef.id}-${revision}`, title: `${staff.name}: ${statusLabel(data.status)} on ${data.date}`, message: data.note ? `Note: ${data.note}` : "Waiting for your approval.", recordType: "attendanceRequest", recordId: rRef.id }],
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
    const asked = a.requestedAmount ?? a.amount;
    const label = `Approved ${peso(ok.amount)}${ok.amount !== asked ? ` (asked ${peso(asked)})` : ""}${ok.installment ? ` · ${peso(ok.installment)} per payroll` : " · deducted all at once"}${ok.note || d.note ? ` · ${ok.note || d.note}` : ""}`;
    tx.update(ref, { status: "not_yet_paid", amount: ok.amount, installment: ok.installment, decision: { by: actor, note: ok.note || d.note }, history: append(a.history, entry(actor, label)), revision: (a.revision || 1) + 1, updatedBy: actor, updatedAt: stamp });
    return { advanceId, status: "not_yet_paid", amount: ok.amount, installment: ok.installment };
  }, TX_OPTIONS);
}

export { validateInstallment, ADVANCE_STATUSES };
