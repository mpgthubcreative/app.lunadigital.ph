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

// Owner-pilot batch (2026-10-11): semi-monthly cutoffs. A cutoff is the LAST
// day of a period: [15, 31] is the usual 1–15 / 16–end; [14, 29] gives
// 30th–14th / 15th–29th. The second cutoff stops at the month's last day
// (29 in February = Feb 28 / 29), so short months never lose or repeat a day.
// null = the usual [15, 31].
export const STANDARD_CUTOFFS = Object.freeze([15, 31]);
export function validateCutoffs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => Number.isSafeInteger(n))) throw new PayrollError("invalid-input", "Cutoffs are two days of the month, e.g. 14 and 29");
  const [a, b] = value;
  if (a < 1 || a > 28 || b > 31 || b - a < 7 || b - a > 23) throw new PayrollError("invalid-input", "Choose cutoffs about half a month apart: the first from 1 to 28, the second 7 to 23 days later (at most 31)");
  return a === 15 && b === 31 ? null : [a, b];
}
const monthBefore = (y, m) => (m === 1 ? [y - 1, 12] : [y, m - 1]);
const monthAfter = (y, m) => (m === 12 ? [y + 1, 1] : [y, m + 1]);
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
function semiMonthly(y, m, d, [a, b]) {
  const second = (yy, mm) => Math.min(b, lastDayOfMonth(yy, mm));
  if (d <= a) {
    const [py, pm] = monthBefore(y, m);
    const pc = second(py, pm);
    return { start: pc === lastDayOfMonth(py, pm) ? ymd(y, m, 1) : ymd(py, pm, pc + 1), end: ymd(y, m, a) };
  }
  if (d <= second(y, m)) return { start: ymd(y, m, a + 1), end: ymd(y, m, second(y, m)) };
  const [ny, nm] = monthAfter(y, m);
  return { start: ymd(y, m, second(y, m) + 1), end: ymd(ny, nm, a) };
}

// The pay period of `cycle` that contains `day` (`cutoffs`: semi-monthly only).
export function periodFor(cycle, day, cutoffs = null) {
  if (!PAY_CYCLES[cycle]) throw new PayrollError("invalid-cycle", "Unknown pay cycle");
  if (!isDayId(day)) throw new PayrollError("invalid-date", "Invalid date");
  const [y, m, d] = parts(day);
  if (cycle === "weekly") {
    const start = addDays(day, -((weekdayOf(day) + 6) % 7)); // back to Monday
    return { start, end: addDays(start, 6) };
  }
  if (cycle === "monthly") return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}` };
  return semiMonthly(y, m, d, Array.isArray(cutoffs) && cutoffs.length === 2 ? cutoffs : STANDARD_CUTOFFS);
}
// A person's own period (their pay cycle and cutoffs).
export const staffPeriod = (staff, day) => periodFor(staff.payCycle, day, staff.payCycle === "semi_monthly" ? staff.cutoffs ?? null : null);
export const cycleLabel = (staff) =>
  staff?.payCycle === "semi_monthly" && Array.isArray(staff.cutoffs) ? `Semi-monthly (cutoffs ${staff.cutoffs[0]} and ${staff.cutoffs[1] >= 31 ? "end" : staff.cutoffs[1]})` : PAY_CYCLES[staff?.payCycle]?.label ?? staff?.payCycle ?? "";

// Is a day of this payroll still open after its salary was paid? Only an
// EARLY payment leaves the days after the payment date open (the period
// hadn't finished); a payment at or after the end locks every day.
export const paidPayrollLocks = (payroll, date) => Boolean(payroll) && payroll.status !== "draft" && !(payroll.paymentTiming === "early" && payroll.salary?.paidDate && date > payroll.salary.paidDate);

// Is {start, end} exactly one period of `cycle`?
export function isPeriodOf(cycle, { start, end } = {}, cutoffs = null) {
  if (!isDayId(start) || !isDayId(end)) return false;
  const p = periodFor(cycle, start, cutoffs);
  return p.start === start && p.end === end;
}

// A person's periods from `from` to `to` (inclusive, newest first), at most `max`.
export function staffPeriods(staff, from, to, max = 24) {
  const out = [];
  if (!isDayId(from) || !isDayId(to) || from > to) return out;
  let p = staffPeriod(staff, to);
  while (out.length < max && p.end >= from) {
    out.push(p);
    p = staffPeriod(staff, addDays(p.start, -1));
  }
  return out;
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

export const STAFF_FIELDS = Object.freeze(["name", "position", "dailyWage", "payCycle", "cutoffs", "advanceLimit", "phone", "startDate", "endDate", "notes"]);

// Owner-pilot batch: a per-person cash advance limit (centavos). null = no
// limit (shown as "No limit"); 0 = no advances.
export function validateAdvanceLimit(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!isCentavos(value) || value < 0 || value > MAX_ADVANCE) throw new PayrollError("invalid-amount", "The advance limit can't be negative");
  return value;
}

// What a person may still borrow. Outstanding = what's left to repay of
// released advances; approved = approved, not yet released (committed);
// requested = waiting for the Owner. available = limit - outstanding -
// approved (null when there's no limit). `exclude`: an advance being decided.
export function advanceCapacity(staff, advances, { exclude = null } = {}) {
  const limit = Number.isSafeInteger(staff?.advanceLimit) ? staff.advanceLimit : null;
  let outstanding = 0;
  let approved = 0;
  let requested = 0;
  for (const a of advances || []) {
    if (exclude && a.id === exclude) continue;
    if (a.status === "paid") outstanding += advanceRemaining(a);
    else if (a.status === "not_yet_paid") approved += a.amount;
    else if (a.status === "requested") requested += a.requestedAmount ?? a.amount;
  }
  return { limit, outstanding, approved, requested, available: limit === null ? null : Math.max(0, limit - outstanding - approved) };
}

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
  if (has("cutoffs")) {
    out.cutoffs = validateCutoffs(input.cutoffs);
    const cycle = input.payCycle ?? (partial ? undefined : "semi_monthly");
    if (out.cutoffs && cycle !== undefined && cycle !== "semi_monthly") throw new PayrollError("invalid-input", "Cutoff days are for semi-monthly pay");
  }
  if (has("advanceLimit")) out.advanceLimit = validateAdvanceLimit(input.advanceLimit);
  if (has("phone")) out.phone = text(input.phone, { field: "Phone", max: 30 });
  if (has("startDate")) {
    if (input.startDate !== null && input.startDate !== undefined && input.startDate !== "" && !isDayId(input.startDate)) throw new PayrollError("invalid-date", "Invalid start date");
    out.startDate = input.startDate || null;
  }
  if (has("endDate")) {
    if (input.endDate !== null && input.endDate !== undefined && input.endDate !== "" && !isDayId(input.endDate)) throw new PayrollError("invalid-date", "Invalid end date");
    out.endDate = input.endDate || null;
  }
  if (has("notes")) out.notes = text(input.notes, { field: "Notes", max: 500 });
  if (out.startDate && out.endDate && out.endDate < out.startDate) throw new PayrollError("invalid-date", "The end date can't be before the start date");
  return out;
}

// Owner-pilot fix (2026-10-11): the Household Staff record is the employee
// master. Is this person on payroll for this period? Employed at some point
// in it (start date on or before its end, no end date before its start) and
// either active or ended within / after it (a final payroll after leaving).
// Returns { eligible, reason }.
export function payrollEligibility(staff, period) {
  if (!staff) return { eligible: false, reason: "No staff record" };
  if (staff.startDate && staff.startDate > period.end) return { eligible: false, reason: `Starts ${staff.startDate}` };
  if (staff.endDate && staff.endDate < period.start) return { eligible: false, reason: `Employment ended ${staff.endDate}` };
  if (staff.status !== "active" && !staff.endDate) return { eligible: false, reason: "Inactive" };
  return { eligible: true, reason: null };
}

// A day's status, only once the day has come (Owner-pilot refinement,
// 2026-10-12: attendance records what actually happened, so an upcoming day
// can't be marked at all, not even as leave or a rest day, and a salary
// paid early never creates attendance).
function checkDay(date, status, today) {
  if (!isDayId(date)) throw new PayrollError("invalid-date", "Invalid date");
  if (!ATTENDANCE_STATUSES[status]) throw new PayrollError("invalid-status", "Choose Present, Absent, Paid Leave, Unpaid Leave or Rest Day");
  if (today && date > today) throw new PayrollError("invalid-date", "That day hasn't come yet: mark it on or after the day");
}

export function validateAttendanceInput({ staffId, date, status, note, reason } = {}, { today }) {
  if (!isValidStaffId(staffId)) throw new PayrollError("invalid-staff", "Choose a staff member");
  checkDay(date, status, today);
  return { staffId, date, status, note: text(note, { field: "Note", max: 200 }), reason: text(reason, { field: "Reason", max: 200 }) };
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

// Why a staff member can't change a day themselves (null = they can).
// Shared by the staff screen (read-only rows) and the server (refusals).
// `recorded`: the employer already marked/approved it (corrections go
// through the employer). `paid`: the day is in a released salary.
export function selfDayLock({ staff, date, today, recorded = false, paid = false }) {
  if (staff?.startDate && date < staff.startDate) return "Before your start date";
  if (staff?.endDate && date > staff.endDate) return "After your last day";
  if (paid) return "In a paid salary";
  if (recorded) return "Approved by your employer";
  if (today && date < addDays(today, -SELF_DAYS_BACK)) return `More than ${SELF_DAYS_BACK} days ago`;
  if (today && date > today) return "Upcoming";
  return null;
}

// Owner-pilot polish: a staff member's own pay-period sheet, several days in
// one submission ({ days: [{ date, status }], note? }). Every day must pass
// the single-day rules; dates are unique; at most MAX_SHEET_DAYS.
export const MAX_SHEET_DAYS = 31;
export function validateAttendanceDays(input, { today }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PayrollError("invalid-input", "Invalid request");
  for (const k of Object.keys(input)) if (!["days", "note"].includes(k)) throw new PayrollError("invalid-input", `Unknown field ${k}`);
  if (!Array.isArray(input.days) || !input.days.length) throw new PayrollError("invalid-input", "Choose at least one day");
  if (input.days.length > MAX_SHEET_DAYS) throw new PayrollError("invalid-input", `Up to ${MAX_SHEET_DAYS} days at a time`);
  const seen = new Set();
  const days = input.days.map((d) => {
    if (!d || typeof d !== "object" || Array.isArray(d) || Object.keys(d).some((k) => !["date", "status"].includes(k))) throw new PayrollError("invalid-input", "Invalid day");
    const v = validateAttendanceRequest({ date: d.date, status: d.status }, { today });
    if (seen.has(v.date)) throw new PayrollError("invalid-input", `${v.date} is listed twice`);
    seen.add(v.date);
    return { date: v.date, status: v.status };
  });
  return { days: days.sort((a, b) => (a.date < b.date ? -1 : 1)), note: text(input.note, { field: "Note", max: 200 }) };
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
// Owner-pilot simplification batch: what's ACTUALLY still owed. Only real
// repayments count: deductions on a paid payroll (deductedAmount) and
// separate repayments the Owner recorded (repaidAmount). Planned
// deductions never do.
export const advanceRemaining = (a) => Math.max(0, (a?.amount ?? 0) - (Number.isSafeInteger(a?.deductedAmount) ? a.deductedAmount : a?.deducted === true ? a.amount : 0) - (Number.isSafeInteger(a?.repaidAmount) ? a.repaidAmount : 0));
export const nextDeduction = (a) => Math.min(advanceRemaining(a), Number.isSafeInteger(a?.installment) && a.installment > 0 ? a.installment : advanceRemaining(a));

// ---------- Repayment schedule (Owner-pilot simplification batch) ----------
//
// Advance -> outstanding balance -> repayment schedule -> actual repayment.
// advance.schedule: [{ id, periodStart, periodEnd, amount, state, ... }]
//   planned    to be deducted by the payroll of that pay period
//   applied    deducted by that payroll when it was paid (real repayment)
//   not_taken  planned, but that payroll was paid without it (or the Owner
//              took it off): still owed; move it, or record a repayment
//   repaid     settled by a separate repayment instead
// One advance can be spread over several periods; one payroll can deduct
// several advances (one traceable line each).
export const SCHEDULE_STATES = Object.freeze({ planned: { label: "Planned" }, applied: { label: "Deducted" }, not_taken: { label: "Not taken" }, repaid: { label: "Repaid separately" } });
export const MAX_SCHEDULE_ENTRIES = 24;
export const scheduleOf = (a) => (Array.isArray(a?.schedule) ? a.schedule : []);
export const plannedEntries = (a) => scheduleOf(a).filter((e) => e.state === "planned");
export const plannedTotal = (a) => plannedEntries(a).reduce((t, e) => t + e.amount, 0);
export const notTakenEntries = (a) => scheduleOf(a).filter((e) => e.state === "not_taken");
// What one advance plans for one pay period (never more than what's owed).
export const plannedFor = (a, periodStart) => Math.min(advanceRemaining(a), plannedEntries(a).filter((e) => e.periodStart === periodStart).reduce((t, e) => t + e.amount, 0));

// A helper's advances at a glance: owed now, the next planned deduction
// (earliest planned period, all advances), and what's left after the plan.
export function advanceSummary(advances) {
  const open = (advances || []).filter((a) => a.status === "paid" && advanceRemaining(a) > 0);
  const outstanding = open.reduce((t, a) => t + advanceRemaining(a), 0);
  const planned = open.flatMap((a) => plannedEntries(a).map((e) => ({ ...e, advanceId: a.id })));
  const first = planned.map((e) => e.periodStart).sort()[0] || null;
  const next = first ? { periodStart: first, periodEnd: planned.find((e) => e.periodStart === first).periodEnd, amount: planned.filter((e) => e.periodStart === first).reduce((t, e) => t + e.amount, 0) } : null;
  const plannedSum = Math.min(outstanding, planned.reduce((t, e) => t + e.amount, 0));
  const notTaken = open.flatMap((a) => notTakenEntries(a)).reduce((t, e) => t + e.amount, 0);
  return { outstanding, next, plannedTotal: plannedSum, balanceAfterPlanned: outstanding - plannedSum, notTaken };
}

// The Owner's new plan for an advance: [{ periodStart, amount, state? }].
// Applied / repaid entries are history and are kept by the server as they
// are. Planned + not taken never exceed what's still owed.
export function validateScheduleInput(input) {
  if (!Array.isArray(input) || input.length > MAX_SCHEDULE_ENTRIES) throw new PayrollError("invalid-input", `A plan has up to ${MAX_SCHEDULE_ENTRIES} deductions`);
  const merged = new Map();
  for (const e of input) {
    if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).some((k) => !["periodStart", "amount", "state"].includes(k))) throw new PayrollError("invalid-input", "Invalid repayment plan");
    if (!isDayId(e.periodStart)) throw new PayrollError("invalid-date", "Choose a pay period");
    const state = e.state ?? "planned";
    if (!["planned", "not_taken"].includes(state)) throw new PayrollError("invalid-input", "Invalid repayment plan");
    if (!isCentavos(e.amount) || e.amount <= 0) throw new PayrollError("invalid-amount", "Each deduction must be more than ₱0");
    const key = `${state}|${e.periodStart}`;
    merged.set(key, { periodStart: e.periodStart, state, amount: (merged.get(key)?.amount ?? 0) + e.amount });
  }
  return [...merged.values()].sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0));
}

// A separate repayment (cash back to the Owner, not through payroll).
export function validateRepayment(input = {}, { today } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PayrollError("invalid-input", "Invalid repayment");
  for (const k of Object.keys(input)) if (!["amount", "date", "method", "reference", "note", "notTakenPeriod"].includes(k)) throw new PayrollError("invalid-input", `Unknown field ${k}`);
  const amount = money(input.amount, { field: "Amount", max: MAX_ADVANCE });
  const date = input.date ?? today;
  if (!isDayId(date)) throw new PayrollError("invalid-date", "Invalid date");
  if (today && date > today) throw new PayrollError("invalid-date", "The repayment date can't be in the future");
  const method = input.method ?? "cash";
  if (!SALARY_METHODS[method]) throw new PayrollError("invalid-input", "Choose how it was repaid");
  if (input.notTakenPeriod !== undefined && input.notTakenPeriod !== null && !isDayId(input.notTakenPeriod)) throw new PayrollError("invalid-date", "Invalid pay period");
  return { amount, date, method, reference: text(input.reference, { field: "Reference", max: 40 }), note: text(input.note, { field: "Note", max: 200 }), notTakenPeriod: input.notTakenPeriod ?? null };
}

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
  for (const k of Object.keys(input)) if (!["method", "reference", "paidDate", "prepaidDays"].includes(k)) throw new PayrollError("invalid-input", `Unknown field ${k}`);
  if (!SALARY_METHODS[input.method]) throw new PayrollError("invalid-input", "Choose how the salary was paid");
  const paidDate = input.paidDate ?? today;
  if (!isDayId(paidDate)) throw new PayrollError("invalid-date", "Invalid paid date");
  if (today && paidDate > today) throw new PayrollError("invalid-date", "The paid date can't be in the future");
  // Owner-pilot refinement: upcoming days paid in advance (prepaid salary).
  const prepaidDays = input.prepaidDays ?? 0;
  if (!Number.isSafeInteger(prepaidDays) || prepaidDays < 0 || prepaidDays > 31) throw new PayrollError("invalid-input", "Choose how many upcoming days to pay");
  return { method: input.method, reference: text(input.reference, { field: "Reference", max: 40 }), paidDate, prepaidDays };
}

// ---------- Owner-pilot refinement: early salary, prepaid days, overpayment ----------
//
// Attendance records reality. A salary payment records money actually given
// (never rewritten). Prepaid salary = the part of an early payment for days
// that hadn't happened yet. Once the period has ended, final salary (what
// attendance earned) vs everything paid gives either:
//   salary overpayment   paid more than earned: owed back, carried to the
//                        next unpaid payroll (its own line, never a cash
//                        advance, never against the advance limit); it drops
//                        only when a paid payroll deducts it, a repayment is
//                        recorded, or the Owner waives it (reason kept)
//   additional salary due  earned more than paid: the Owner records it
// The ledger sits on the paid payroll it came from (p.overpayment:
// { plan, applied, repayments, waivers }).
const sumOf = (list) => (Array.isArray(list) ? list : []).reduce((t, x) => t + (Number.isSafeInteger(x?.amount) ? x.amount : 0), 0);
export const paidTotal = (p) => (p?.salary?.amount ?? 0) + sumOf(p?.salary?.additional);
export function reconcileOf(p, today) {
  if (p?.status !== "released" || !p.salary) return null;
  const ended = Boolean(today) && today > p.periodEnd;
  const paid = paidTotal(p);
  const final = Number.isSafeInteger(p.netPay) ? p.netPay : 0;
  const diff = final - paid;
  const op = p.overpayment || {};
  // Days still not recorded after the period: wait (a forgotten day isn't
  // treated as "not earned"); the Owner records them, then it settles.
  const unrecorded = Number.isSafeInteger(p.notMarked) ? p.notMarked : 0;
  const waiting = ended && unrecorded > 0;
  const overpaid = ended && !waiting && diff < 0 ? -diff : 0;
  const applied = sumOf(op.applied);
  const repaid = sumOf(op.repayments);
  const waived = sumOf(op.waivers);
  return { ended, waiting, unrecorded: waiting ? unrecorded : 0, paid, final, diff, overpaid, applied, repaid, waived, outstanding: Math.max(0, overpaid - applied - repaid - waived), additionalDue: ended && !waiting && diff > 0 ? diff : 0, settled: ended && !waiting && diff === 0 };
}
