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
//   Present and Official Leave are payable; Absent isn't. A day nobody
//   marked isn't payable either (shown as "Not marked").
//   Payable Days = Present + Official Leave
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

export const ATTENDANCE_STATUSES = Object.freeze({
  present: { label: "Present", payable: true },
  absent: { label: "Absent", payable: false },
  official_leave: { label: "Official Leave", payable: true },
});
export const ATTENDANCE_STATUS_IDS = Object.freeze(Object.keys(ATTENDANCE_STATUSES));
export const isPayableStatus = (status) => ATTENDANCE_STATUSES[status]?.payable === true;

export const STAFF_STATUSES = Object.freeze({ active: { label: "Active" }, inactive: { label: "Inactive" } });

// Payroll: draft (calculating; attendance still changes it) -> released
// (salary paid; the period is locked).
export const PAYROLL_STATUSES = Object.freeze({ draft: { label: "Not yet paid" }, released: { label: "Paid" } });
// Receipt confirmation, separate from payment.
export const RECEIPT_STATUSES = Object.freeze({ none: { label: "—" }, awaiting: { label: "Awaiting confirmation" }, confirmed: { label: "Confirmed" } });

export const ADVANCE_STATUSES = Object.freeze({ not_yet_paid: { label: "Not Yet Paid" }, paid: { label: "Paid" } });

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
export function summarizeAttendance(lines, period) {
  const total = daysIn(period).length;
  const out = { present: 0, absent: 0, officialLeave: 0, notMarked: 0, payableDays: 0, basePay: 0 };
  for (const l of lines) {
    if (l.status === "present") out.present += 1;
    else if (l.status === "absent") out.absent += 1;
    else if (l.status === "official_leave") out.officialLeave += 1;
    else continue;
    if (isPayableStatus(l.status)) {
      out.payableDays += 1;
      out.basePay += l.dailyWage;
    }
  }
  out.notMarked = total - out.present - out.absent - out.officialLeave;
  return out;
}

export const deductionsTotal = (deductions) => (deductions || []).reduce((s, d) => s + d.amount, 0);
export const netPayOf = (basePay, deductions) => basePay - deductionsTotal(deductions);

// What one attendance line contributes to its payroll (for in-place deltas).
export const lineContribution = (line) =>
  !line || !ATTENDANCE_STATUSES[line.status]
    ? { present: 0, absent: 0, officialLeave: 0, notMarked: 1, payableDays: 0, basePay: 0 }
    : {
        present: line.status === "present" ? 1 : 0,
        absent: line.status === "absent" ? 1 : 0,
        officialLeave: line.status === "official_leave" ? 1 : 0,
        notMarked: 0,
        payableDays: isPayableStatus(line.status) ? 1 : 0,
        basePay: isPayableStatus(line.status) ? line.dailyWage : 0,
      };

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

export function validateAttendanceInput({ staffId, date, status, note } = {}, { today }) {
  if (!isValidStaffId(staffId)) throw new PayrollError("invalid-staff", "Choose a staff member");
  if (!isDayId(date)) throw new PayrollError("invalid-date", "Invalid date");
  if (today && date > today) throw new PayrollError("invalid-date", "Attendance can't be marked for a future date");
  if (!ATTENDANCE_STATUSES[status]) throw new PayrollError("invalid-status", "Choose Present, Absent or Official Leave");
  return { staffId, date, status, note: text(note, { field: "Note", max: 200 }) };
}

export function validateAdvanceInput(input, { today } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PayrollError("invalid-input", "Invalid advance");
  for (const k of Object.keys(input)) if (!["staffId", "date", "description", "amount"].includes(k)) throw new PayrollError("invalid-input", `Unknown field ${k}`);
  if (!isValidStaffId(input.staffId)) throw new PayrollError("invalid-staff", "Choose a staff member");
  if (!isDayId(input.date)) throw new PayrollError("invalid-date", "Invalid date");
  if (today && input.date > today) throw new PayrollError("invalid-date", "An advance can't be dated in the future");
  return { staffId: input.staffId, date: input.date, description: text(input.description, { field: "Description", max: 120 }), amount: money(input.amount, { field: "Amount", max: MAX_ADVANCE }) };
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
