// Household / Kasambahay Payroll (Phase 14): the shared vocabulary, pay
// periods, the payroll calculation and input validation. Server and UI use
// the same functions; only the server writes.
//
// Records (businesses/{bid}/...):
//   householdStaff/{staffId}      name, position, dailyWage, payCycle, status
//   attendance/{staffId}_{day}    one line per person per business-local day:
//                                 status, dailyWage (snapshot), payable, amount
//   payrolls/{staffId}_{start}    one payroll per person per period: counts,
//                                 base pay, deductions, net pay, salary
//                                 release, receipt confirmation
//   advances/{advanceId}          release (Not Yet Paid / Paid) and, once
//                                 paid, the payroll that deducts it
//
// Rules (docs/ARCHITECTURE.md "Luna-wide product requirements" 8-15):
//   Present and Paid Leave (id official_leave) are payable; Absent, Unpaid
//   Leave and Rest Day aren't. A day nobody marked isn't payable either
//   (shown as "Not marked").
//   Phase 18.6, Kasambahay Law (RA 10361) note: Luna pays a DAILY wage, so
//   a rest day is a day not worked and not paid ("no work, no pay"), never
//   a deduction from a wage that already covers it. If monthly-rated staff
//   are added, rest days must stay inside the monthly wage (see
//   docs/phase-18-6-progress.md, "Payroll legal notes").
//   Payable Days = Present + Paid Leave
//   Base Pay     = sum of each payable day's daily wage (= Daily Wage x
//                  Payable Days when the wage didn't change in the period).
//                  Luna calculates it; nobody types it.
//   Net Pay      = Base Pay - Deductions (advances deducted in full + manual)
//   Salary paid (released) and receipt confirmed are separate states.

import { isDayId, addDays } from "./metrics.js";
import { isCentavos } from "./quantity.js";

export const PAYROLL_SCHEMA_VERSION = 1;

export const PAY_CYCLES = Object.freeze({
  weekly: { label: "Weekly (Mon–Sun)" },
  semi_monthly: { label: "Semi-monthly (1–15, 16–end)" },
  monthly: { label: "Monthly" },
});
export const PAY_CYCLE_IDS = Object.freeze(Object.keys(PAY_CYCLES));

// `ahead`: may be recorded for a future day (planned leave or rest day).
export const ATTENDANCE_STATUSES = Object.freeze({
  present: { label: "Present", payable: true, short: "P" },
  absent: { label: "Absent", payable: false, short: "A" },
  official_leave: { label: "Paid Leave", payable: true, ahead: true, short: "PL" },
  unpaid_leave: { label: "Unpaid Leave", payable: false, ahead: true, short: "UL" },
  rest_day: { label: "Rest Day", payable: false, ahead: true, short: "R" },
});
// How far ahead leave / rest days can be planned.
export const MAX_DAYS_AHEAD = 90;
// How far back a staff member may submit their own attendance.
export const SELF_DAYS_BACK = 14;
export const ATTENDANCE_STATUS_IDS = Object.freeze(Object.keys(ATTENDANCE_STATUSES));
export const isPayableStatus = (status) => ATTENDANCE_STATUSES[status]?.payable === true;

export const STAFF_STATUSES = Object.freeze({ active: { label: "Active" }, inactive: { label: "Inactive" } });

// Payroll: draft (calculating; attendance still changes it) -> released
// (salary paid; the period is locked).
export const PAYROLL_STATUSES = Object.freeze({ draft: { label: "Not yet paid" }, released: { label: "Paid" } });
// Receipt confirmation, separate from payment.
export const RECEIPT_STATUSES = Object.freeze({ none: { label: "—" }, awaiting: { label: "Awaiting confirmation" }, confirmed: { label: "Confirmed" } });

// Phase 18.6: requested by the staff member -> approved by the owner (not
// released yet) -> released (paid to the employee) -> deducted by payroll
// installments until nothing is left; or rejected. Ids stay as before
// (not_yet_paid = approved, paid = released) so older records keep working.
export const ADVANCE_STATUSES = Object.freeze({
  requested: { label: "Requested" },
  not_yet_paid: { label: "Approved, not released" },
  paid: { label: "Released" },
  rejected: { label: "Rejected" },
});
// Staff self-service requests (attendance / leave) awaiting the owner.
export const REQUEST_STATES = Object.freeze({ pending: { label: "Waiting for approval" }, approved: { label: "Approved" }, rejected: { label: "Rejected" } });

export const SALARY_METHODS = Object.freeze({
  cash: { label: "Cash" },
  gcash: { label: "GCash" },
  maya: { label: "Maya" },
  bank_transfer: { label: "Bank Transfer" },
  other: { label: "Other" },
});
export const SALARY_METHOD_IDS = Object.freeze(Object.keys(SALARY_METHODS));

// Typo guards, not business rules.
export const MAX_DAILY_WAGE = 10_000_000; // ₱100,000 a day
export const MAX_ADVANCE = 100_000_000; // ₱1,000,000
export const MAX_DEDUCTIONS_PER_PAYROLL = 50;
// A receipt link is valid this long after it's issued.
export const RECEIPT_LINK_DAYS = 14;

export class PayrollError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const STAFF_ID = /^[A-Za-z0-9]{8,40}$/;
const ADVANCE_ID = /^[A-Za-z0-9]{8,40}$/;
export const isValidStaffId = (v) => typeof v === "string" && STAFF_ID.test(v);
export const isValidAdvanceId = (v) => typeof v === "string" && ADVANCE_ID.test(v);
export const attendanceId = (staffId, day) => `${staffId}_${day}`;
export const payrollId = (staffId, periodStart) => `${staffId}_${periodStart}`;
const PAYROLL_ID = /^([A-Za-z0-9]{8,40})_(\d{4}-\d{2}-\d{2})$/;
export const isValidPayrollId = (v) => typeof v === "string" && PAYROLL_ID.test(v) && isDayId(PAYROLL_ID.exec(v)[2]);

// ---------- Days and periods (business-local YYYY-MM-DD) ----------

const parts = (day) => day.split("-").map(Number);
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, "0");
export const weekdayOf = (day) => {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const weekdayLabel = (day) => WEEKDAYS[weekdayOf(day)];

// The pay period of `cycle` that contains `day`.
export function periodFor(cycle, day) {
  if (!PAY_CYCLES[cycle]) throw new PayrollError("invalid-cycle", "Unknown pay cycle");
  if (!isDayId(day)) throw new PayrollError("invalid-date", "Invalid date");
  const [y, m, d] = parts(day);
  if (cycle === "weekly") {
    const start = addDays(day, -((weekdayOf(day) + 6) % 7)); // back to Monday
    return { start, end: addDays(start, 6) };
  }
  if (cycle === "monthly") return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}` };
  return d <= 15 ? { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-15` } : { start: `${y}-${pad(m)}-16`, end: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}` };
}

// Is {start, end} exactly one period of `cycle`?
export function isPeriodOf(cycle, { start, end } = {}) {
  if (!isDayId(start) || !isDayId(end)) return false;
  const p = periodFor(cycle, start);
  return p.start === start && p.end === end;
}

export function daysIn({ start, end }) {
  const out = [];
  for (let d = start; d <= end && out.length < 31; d = addDays(d, 1)) out.push(d);
  return out;
}

export const periodLabel = ({ start, end }) => `${start} to ${end}`;

// ---------- Calculation ----------

// lines: attendance records of ONE person within the period.
// Status -> the payroll counter it adds to.
const COUNTER = { present: "present", absent: "absent", official_leave: "officialLeave", unpaid_leave: "unpaidLeave", rest_day: "restDay" };
const COUNTERS = Object.values(COUNTER);

export function summarizeAttendance(lines, period) {
  const total = daysIn(period).length;
  const out = { present: 0, absent: 0, officialLeave: 0, unpaidLeave: 0, restDay: 0, notMarked: 0, payableDays: 0, basePay: 0 };
  for (const l of lines) {
    const k = COUNTER[l.status];
    if (!k) continue;
    out[k] += 1;
    if (isPayableStatus(l.status)) {
      out.payableDays += 1;
      out.basePay += l.dailyWage;
    }
  }
  out.notMarked = total - COUNTERS.reduce((t, k) => t + out[k], 0);
  return out;
}

export const deductionsTotal = (deductions) => (deductions || []).reduce((s, d) => s + d.amount, 0);
export const netPayOf = (basePay, deductions) => basePay - deductionsTotal(deductions);

// What one attendance line contributes to its payroll (for in-place deltas).
export const lineContribution = (line) => {
  const out = { present: 0, absent: 0, officialLeave: 0, unpaidLeave: 0, restDay: 0, notMarked: 0, payableDays: 0, basePay: 0 };
  if (!line || !ATTENDANCE_STATUSES[line.status]) return { ...out, notMarked: 1 };
  out[COUNTER[line.status]] = 1;
  out.payableDays = isPayableStatus(line.status) ? 1 : 0;
  out.basePay = isPayableStatus(line.status) ? line.dailyWage : 0;
  return out;
};
// A payroll's counters after one attendance line changes (older payrolls
// have no unpaidLeave / restDay fields: they read as 0).
export function applyLineChange(payroll, before, after) {
  const a = lineContribution(before);
  const b = lineContribution(after);
  return Object.fromEntries(Object.keys(a).map((k) => [k, (Number.isSafeInteger(payroll[k]) ? payroll[k] : 0) + b[k] - a[k]]));
}

// ---------- Validation ----------

function text(value, { field, max, required = false }) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new PayrollError("invalid-input", `${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new PayrollError("invalid-input", `${field} must be text`);
  const t = value.trim().replace(/\s+/g, " ");
  if (!t && required) throw new PayrollError("invalid-input", `${field} is required`);
  if (t.length > max) throw new PayrollError("invalid-input", `${field} is too long (max ${max})`);
  return t || null;
}

const money = (v, { field, max }) => {
  if (!isCentavos(v) || v <= 0 || v > max) throw new PayrollError("invalid-amount", `${field} must be more than ₱0`);
  return v;
};

export const STAFF_FIELDS = Object.freeze(["name", "position", "dailyWage", "payCycle", "phone", "startDate", "notes"]);

// New staff (all required fields) or an edit (`partial`: only given keys).
export function validateStaffInput(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PayrollError("invalid-input", "Invalid staff details");
  for (const k of Object.keys(input)) if (!STAFF_FIELDS.includes(k)) throw new PayrollError("invalid-input", `Unknown field ${k}`);
  const out = {};
  const has = (k) => !partial || k in input;
  if (has("name")) out.name = text(input.name, { field: "Name", max: 80, required: true });
  if (has("position")) out.position = text(input.position, { field: "Position", max: 60 });
  if (has("dailyWage")) out.dailyWage = money(input.dailyWage, { field: "Daily wage", max: MAX_DAILY_WAGE });
  if (has("payCycle")) {
    if (!PAY_CYCLES[input.payCycle]) throw new PayrollError("invalid-input", "Choose a pay cycle");
    out.payCycle = input.payCycle;
  }
  if (has("phone")) out.phone = text(input.phone, { field: "Phone", max: 30 });
  if (has("startDate")) {
    if (input.startDate !== null && input.startDate !== undefined && input.startDate !== "" && !isDayId(input.startDate)) throw new PayrollError("invalid-date", "Invalid start date");
    out.startDate = input.startDate || null;
  }
  if (has("notes")) out.notes = text(input.notes, { field: "Notes", max: 500 });
  return out;
}

// A day's status: Present / Absent only up to today; Paid Leave, Unpaid
// Leave and Rest Day may be planned up to MAX_DAYS_AHEAD days ahead.
function checkDay(date, status, today) {
  if (!isDayId(date)) throw new PayrollError("invalid-date", "Invalid date");
  if (!ATTENDANCE_STATUSES[status]) throw new PayrollError("invalid-status", "Choose Present, Absent, Paid Leave, Unpaid Leave or Rest Day");
  if (today && date > today) {
    if (!ATTENDANCE_STATUSES[status].ahead) throw new PayrollError("invalid-date", "Present or Absent can't be marked for a future date");
    if (date > addDays(today, MAX_DAYS_AHEAD)) throw new PayrollError("invalid-date", `Leave can be planned up to ${MAX_DAYS_AHEAD} days ahead`);
  }
}

export function validateAttendanceInput({ staffId, date, status, note } = {}, { today }) {
  if (!isValidStaffId(staffId)) throw new PayrollError("invalid-staff", "Choose a staff member");
  checkDay(date, status, today);
  return { staffId, date, status, note: text(note, { field: "Note", max: 200 }) };
}

// Phase 18.6: a staff member's own request (their staffId comes from their
// account, never from the request). Not more than SELF_DAYS_BACK days back.
export function validateAttendanceRequest(input, { today }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PayrollError("invalid-input", "Invalid request");
  for (const k of Object.keys(input)) if (!["date", "status", "note"].includes(k)) throw new PayrollError("invalid-input", `Unknown field ${k}`);
  checkDay(input.date, input.status, today);
  if (today && input.date < addDays(today, -SELF_DAYS_BACK)) throw new PayrollError("invalid-date", `Ask your employer to fix days more than ${SELF_DAYS_BACK} days ago`);
  return { date: input.date, status: input.status, note: text(input.note, { field: "Note", max: 200 }) };
}

// The owner's decision on a request.
export function validateDecision(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PayrollError("invalid-input", "Invalid decision");
  if (!["approve", "reject"].includes(input.decision)) throw new PayrollError("invalid-input", "Approve or reject");
  return { decision: input.decision, note: text(input.note, { field: "Note", max: 200 }) };
}

export function validateAdvanceInput(input, { today } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PayrollError("invalid-input", "Invalid advance");
  for (const k of Object.keys(input)) if (!["staffId", "date", "description", "amount", "installment"].includes(k)) throw new PayrollError("invalid-input", `Unknown field ${k}`);
  if (!isValidStaffId(input.staffId)) throw new PayrollError("invalid-staff", "Choose a staff member");
  if (!isDayId(input.date)) throw new PayrollError("invalid-date", "Invalid date");
  if (today && input.date > today) throw new PayrollError("invalid-date", "An advance can't be dated in the future");
  const amount = money(input.amount, { field: "Amount", max: MAX_ADVANCE });
  return { staffId: input.staffId, date: input.date, description: text(input.description, { field: "Description", max: 120 }), amount, installment: validateInstallment(input.installment, amount) };
}

// Phase 18.6: how much each payroll deducts until the advance is repaid.
// null / missing = all of it on the next payroll (the Phase 14 rule).
export function validateInstallment(value, amount) {
  if (value === undefined || value === null || value === "") return null;
  if (!isCentavos(value) || value <= 0) throw new PayrollError("invalid-amount", "The amount per payroll must be more than ₱0");
  return value >= amount ? null : value;
}

// The next deduction of a released advance: its installment (or all of
// it), never more than what's left.
export const advanceRemaining = (a) => Math.max(0, (a?.amount ?? 0) - (Number.isSafeInteger(a?.deductedAmount) ? a.deductedAmount : a?.deducted === true ? a.amount : 0));
export const nextDeduction = (a) => Math.min(advanceRemaining(a), Number.isSafeInteger(a?.installment) && a.installment > 0 ? a.installment : advanceRemaining(a));

// A staff member's own request: the amount and why.
export function validateAdvanceRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PayrollError("invalid-input", "Invalid request");
  for (const k of Object.keys(input)) if (!["amount", "reason"].includes(k)) throw new PayrollError("invalid-input", `Unknown field ${k}`);
  return { amount: money(input.amount, { field: "Amount", max: MAX_ADVANCE }), reason: text(input.reason, { field: "Reason", max: 200 }) };
}

// The owner's approval: the approved amount (may differ from the request)
// and the amount per payroll.
export function validateAdvanceApproval(input, requested) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PayrollError("invalid-input", "Invalid approval");
  for (const k of Object.keys(input)) if (!["amount", "installment", "note"].includes(k)) throw new PayrollError("invalid-input", `Unknown field ${k}`);
  const amount = input.amount === undefined ? requested : money(input.amount, { field: "Approved amount", max: MAX_ADVANCE });
  return { amount, installment: validateInstallment(input.installment, amount), note: text(input.note, { field: "Note", max: 200 }) };
}

// Marking an advance Paid (released to the employee).
export function validateAdvanceRelease(input = {}, { today } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PayrollError("invalid-input", "Invalid release");
  for (const k of Object.keys(input)) if (!["paidDate", "method", "reference"].includes(k)) throw new PayrollError("invalid-input", `Unknown field ${k}`);
  const paidDate = input.paidDate ?? today;
  if (!isDayId(paidDate)) throw new PayrollError("invalid-date", "Invalid paid date");
  if (today && paidDate > today) throw new PayrollError("invalid-date", "The paid date can't be in the future");
  const method = input.method ?? "cash";
  if (!SALARY_METHODS[method]) throw new PayrollError("invalid-input", "Choose a payment method");
  return { paidDate, method, reference: text(input.reference, { field: "Reference", max: 40 }) };
}

export function validateManualDeduction(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PayrollError("invalid-input", "Invalid deduction");
  for (const k of Object.keys(input)) if (!["description", "amount"].includes(k)) throw new PayrollError("invalid-input", `Unknown field ${k}`);
  return { description: text(input.description, { field: "Description", max: 120, required: true }), amount: money(input.amount, { field: "Amount", max: MAX_ADVANCE }) };
}

// Releasing (paying) a salary.
export function validateSalaryRelease(input = {}, { today } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PayrollError("invalid-input", "Invalid payment");
  for (const k of Object.keys(input)) if (!["method", "reference", "paidDate"].includes(k)) throw new PayrollError("invalid-input", `Unknown field ${k}`);
  if (!SALARY_METHODS[input.method]) throw new PayrollError("invalid-input", "Choose how the salary was paid");
  const paidDate = input.paidDate ?? today;
  if (!isDayId(paidDate)) throw new PayrollError("invalid-date", "Invalid paid date");
  if (today && paidDate > today) throw new PayrollError("invalid-date", "The paid date can't be in the future");
  return { method: input.method, reference: text(input.reference, { field: "Reference", max: 40 }), paidDate };
}
