// Phase 14 payroll workbooks, through the Export Core (runExport): the same
// list specs as the screens (shared/list-queries.js), every matching row,
// refused past the row limit. Example: Employee = Maria, Periods Oct 1-15 ->
// her payroll, its additions and deductions and the attendance behind it.
//
// Phase 18.6: ONE worksheet per download. The payroll report mixes record
// types on purpose (Record column): a "Payroll" row with the period's
// totals, then its "Bonus" / "13th month" / "Advance deduction" /
// "Deduction" lines and the "Attendance" days. Money sits in separate
// columns per record type, and only the Payroll rows' money columns are
// totalled, so nothing is counted twice.

import { householdStaffQuery, attendanceQuery, payrollsQuery, advancesQuery } from "../../../../shared/list-queries.js";
import { ATTENDANCE_STATUSES, PAY_CYCLES, ADVANCE_STATUSES, SALARY_METHODS, weekdayLabel, advanceRemaining } from "../../../../shared/payroll.js";

const label = (map, key) => map[key]?.label ?? key ?? "";
const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const sumOf = (list, pick) => (list || []).filter(pick).reduce((t, x) => t + int(x.amount), 0);
const isPay = (r) => r.record === "Payroll";
const payState = (p) => (p.status !== "released" ? "Not paid" : p.ownerPayment === "disputed" ? "Disputed" : "Paid");
const received = (p) => (p.status !== "released" ? "" : p.receiptStatus === "confirmed" ? "Received" : p.dispute?.state === "open" ? "Not received" : "Not confirmed");
const toDay = (v) => {
  const d = v instanceof Date ? v : typeof v?.toDate === "function" ? v.toDate() : null;
  return d ? d.toISOString().slice(0, 10) : null;
};

const STAFF_COLUMNS = [
  { header: "Name", format: "text", width: 24, value: (s) => s.name },
  { header: "Employee ID", format: "text", width: 22, value: (s) => s.id },
  { header: "Position", format: "text", width: 18, value: (s) => s.position },
  { header: "Daily wage", format: "money", width: 12, value: (s) => s.dailyWage },
  { header: "Pay cycle", format: "text", width: 26, value: (s) => label(PAY_CYCLES, s.payCycle) },
  { header: "Phone", format: "text", width: 16, value: (s) => s.phone },
  { header: "Start date", format: "date", width: 12, value: (s) => s.startDate },
  { header: "Employment status", format: "text", width: 12, value: (s) => (s.status === "active" ? "Active" : "Inactive") },
  { header: "Luna login", format: "text", width: 18, value: (s) => (s.login ? { pending: "Waiting to set up", active: "Active", disabled: "Off" }[s.login.status] ?? s.login.status : "No login") },
  { header: "Notes", format: "text", width: 30, value: (s) => s.notes },
];

const ATTENDANCE_COLUMNS = [
  { header: "Date", format: "date", width: 12, value: (a) => a.date },
  { header: "Day", format: "text", width: 6, value: (a) => weekdayLabel(a.date) },
  { header: "Employee", format: "text", width: 22, value: (a) => a.staffName },
  { header: "Employee ID", format: "text", width: 22, value: (a) => a.staffId },
  { header: "Status", format: "text", width: 14, value: (a) => label(ATTENDANCE_STATUSES, a.status) },
  { header: "Paid day", format: "bool", width: 9, value: (a) => a.payable === true },
  { header: "Daily wage", format: "money", width: 12, value: (a) => a.dailyWage },
  { header: "Day pay", format: "money", width: 12, total: true, value: (a) => a.payableAmount },
  { header: "Notes", format: "text", width: 30, value: (a) => a.note },
];

const PAYROLL_COLUMNS = [
  { header: "Record", format: "text", width: 16, value: (r) => r.record },
  { header: "Employee", format: "text", width: 22, value: (r) => r.p.staffName },
  { header: "Employee ID", format: "text", width: 22, value: (r) => r.p.staffId },
  { header: "Employment status", format: "text", width: 12, value: (r) => (isPay(r) ? (r.staff?.status === "inactive" ? "Inactive" : r.staff ? "Active" : "") : null) },
  { header: "Period start", format: "date", width: 12, value: (r) => r.p.periodStart },
  { header: "Period end", format: "date", width: 12, value: (r) => r.p.periodEnd },
  { header: "Date", format: "date", width: 12, value: (r) => r.date ?? null },
  { header: "Item", format: "text", width: 30, value: (r) => r.item ?? null },
  { header: "Present", format: "integer", width: 8, value: (r) => (isPay(r) ? int(r.p.present) : null) },
  { header: "Paid leave", format: "integer", width: 8, value: (r) => (isPay(r) ? int(r.p.officialLeave) : null) },
  { header: "Unpaid leave", format: "integer", width: 8, value: (r) => (isPay(r) ? int(r.p.unpaidLeave) : null) },
  { header: "Rest days", format: "integer", width: 8, value: (r) => (isPay(r) ? int(r.p.restDay) : null) },
  { header: "Absent", format: "integer", width: 8, value: (r) => (isPay(r) ? int(r.p.absent) : null) },
  { header: "Daily wage", format: "money", width: 12, value: (r) => (isPay(r) ? r.p.dailyWage : r.record === "Attendance" ? r.line.dailyWage : null) },
  { header: "Basic pay", format: "money", width: 13, total: true, value: (r) => (isPay(r) ? r.p.basePay : null) },
  { header: "Bonus", format: "money", width: 12, total: true, value: (r) => (isPay(r) ? sumOf(r.p.additions, (a) => a.type === "bonus") : null) },
  { header: "13th month pay", format: "money", width: 13, total: true, value: (r) => (isPay(r) ? sumOf(r.p.additions, (a) => a.type === "thirteenth") : null) },
  { header: "Gross pay", format: "money", width: 13, total: true, value: (r) => (isPay(r) ? r.p.grossPay ?? int(r.p.basePay) + int(r.p.additionsTotal) : null) },
  { header: "Advances deducted", format: "money", width: 13, total: true, value: (r) => (isPay(r) ? sumOf(r.p.deductions, (d) => d.type === "advance") : null) },
  { header: "Other deductions", format: "money", width: 13, total: true, value: (r) => (isPay(r) ? sumOf(r.p.deductions, (d) => d.type !== "advance") : null) },
  { header: "Net pay", format: "money", width: 13, total: true, value: (r) => (isPay(r) ? r.p.netPay : null) },
  { header: "Line amount", format: "money", width: 13, value: (r) => r.amount ?? null },
  { header: "Payment method", format: "text", width: 14, value: (r) => (isPay(r) && r.p.salary ? label(SALARY_METHODS, r.p.salary.method) : null) },
  { header: "Paid date", format: "date", width: 12, value: (r) => (isPay(r) ? r.p.salary?.paidDate ?? null : null) },
  { header: "Owner payment", format: "text", width: 12, value: (r) => (isPay(r) ? payState(r.p) : null) },
  { header: "Payment proof", format: "text", width: 12, value: (r) => (isPay(r) && r.p.status === "released" ? (r.p.salary?.proof ? "Attached" : "None") : null) },
  { header: "Reference", format: "text", width: 16, value: (r) => (isPay(r) ? r.p.salary?.reference ?? null : null) },
  { header: "Employee received", format: "text", width: 14, value: (r) => (isPay(r) ? received(r.p) : null) },
  { header: "Confirmed date", format: "date", width: 12, value: (r) => (isPay(r) ? toDay(r.p.receiptConfirmedAt) : null) },
  { header: "Advance balance left (now)", format: "money", width: 14, value: (r) => (isPay(r) ? r.advanceLeft ?? null : null) },
  { header: "Notes", format: "text", width: 30, value: (r) => r.note ?? (isPay(r) && r.p.dispute?.state === "open" ? `Not received: ${r.p.dispute.note ?? ""}` : null) },
];

const ADVANCE_COLUMNS = [
  { header: "Date", format: "date", width: 12, value: (a) => a.date },
  { header: "Employee", format: "text", width: 22, value: (a) => a.staffName },
  { header: "Employee ID", format: "text", width: 22, value: (a) => a.staffId },
  { header: "Reason", format: "text", width: 30, value: (a) => a.description },
  { header: "Requested", format: "money", width: 12, value: (a) => a.requestedAmount ?? null },
  { header: "Approved amount", format: "money", width: 13, total: true, value: (a) => (a.status === "requested" || a.status === "rejected" ? null : a.amount) },
  { header: "Status", format: "text", width: 18, value: (a) => label(ADVANCE_STATUSES, a.status) },
  { header: "Released date", format: "date", width: 12, value: (a) => a.paidDate },
  { header: "Payment method", format: "text", width: 14, value: (a) => (a.method ? label(SALARY_METHODS, a.method) : "") },
  { header: "Reference", format: "text", width: 16, value: (a) => a.reference },
  { header: "Per payroll", format: "money", width: 12, value: (a) => a.installment ?? null },
  { header: "Deducted so far", format: "money", width: 13, total: true, value: (a) => (a.status === "paid" ? a.amount - advanceRemaining(a) : null) },
  { header: "Left to repay", format: "money", width: 13, total: true, value: (a) => (a.status === "paid" ? advanceRemaining(a) : null) },
  { header: "Next payroll deduction", format: "text", width: 14, value: (a) => (a.status === "paid" && advanceRemaining(a) > 0 ? (a.deductionPayrollId ? "On an unpaid payroll" : "Next payroll") : "") },
  { header: "Answer / note", format: "text", width: 26, value: (a) => a.decision?.note ?? null },
];

async function householdStaff({ filters, readRows }) {
  const rows = await readRows("householdStaff", householdStaffQuery(filters));
  return { rowCount: rows.length, table: { name: "Household Staff", columns: STAFF_COLUMNS, rows } };
}

async function attendance({ filters, readRows }) {
  const rows = await readRows("attendance", attendanceQuery(filters));
  return { rowCount: rows.length, table: { name: "Attendance", columns: ATTENDANCE_COLUMNS, rows }, note: "Present and Paid Leave are paid days; Absent, Unpaid Leave and Rest Day aren't." };
}

// Payroll + its additions, deductions and the attendance of the exported
// periods (ONE attendance query over the overall date range, then matched
// to each payroll: no query per payroll).
async function payroll({ filters, readRows, readByIds }) {
  const rows = await readRows("payrolls", payrollsQuery(filters));
  let lines = [];
  let staff = new Map();
  let advanceLeft = new Map();
  if (rows.length) {
    const from = rows.reduce((m, p) => (p.periodStart < m ? p.periodStart : m), rows[0].periodStart);
    const to = rows.reduce((m, p) => (p.periodEnd > m ? p.periodEnd : m), rows[0].periodEnd);
    const covered = (a) => rows.some((p) => p.staffId === a.staffId && a.date >= p.periodStart && a.date <= p.periodEnd);
    lines = (await readRows("attendance", attendanceQuery({ staffId: filters.staffId, from, to }))).filter(covered);
    const ids = [...new Set(rows.map((p) => p.staffId))];
    staff = await readByIds("householdStaff", ids);
    const adv = await readRows("advances", advancesQuery({ ...(filters.staffId ? { staffId: filters.staffId } : {}), status: "paid" }));
    for (const a of adv) advanceLeft.set(a.staffId, (advanceLeft.get(a.staffId) || 0) + advanceRemaining(a));
  }
  const out = rows.flatMap((p) => [
    { record: "Payroll", p, staff: staff.get(p.staffId) ?? null, advanceLeft: advanceLeft.get(p.staffId) ?? 0, item: `${p.payableDays} paid days` },
    ...(p.additions || []).map((a) => ({ record: a.type === "thirteenth" ? "13th month" : "Bonus", p, date: p.periodEnd, item: a.description, amount: a.amount, note: a.type === "thirteenth" ? `13th month pay ${a.year}` : null })),
    ...(p.deductions || []).map((d) => ({ record: d.type === "advance" ? "Advance deduction" : "Deduction", p, date: p.periodEnd, item: d.description, amount: d.amount })),
    ...lines.filter((l) => l.staffId === p.staffId && l.date >= p.periodStart && l.date <= p.periodEnd).sort((a, b) => (a.date < b.date ? -1 : 1)).map((l) => ({ record: "Attendance", p, line: l, date: l.date, item: `${weekdayLabel(l.date)} · ${label(ATTENDANCE_STATUSES, l.status)}`, amount: l.payableAmount, note: l.note ?? null })),
  ]);
  return {
    rowCount: rows.length,
    table: { name: "Payroll", columns: PAYROLL_COLUMNS, rows: out },
    note: "Basic pay = the daily wage of each Present or Paid Leave day. Gross = basic + bonus + 13th month. Net = gross − deductions. Totals add Payroll rows only; Line amount details each bonus, deduction and day.",
  };
}

async function advances({ filters, readRows }) {
  const rows = await readRows("advances", advancesQuery(filters));
  return { rowCount: rows.length, table: { name: "Advances", columns: ADVANCE_COLUMNS, rows }, note: "Approved is not released: money moves when an advance is marked Released. Left to repay is as of export time." };
}

export const PAYROLL_BUILDERS = Object.freeze({ householdStaff, attendance, payroll, advances });
