// Phase 14 payroll workbooks, through the Export Core (runExport): the same
// list specs as the screens (shared/list-queries.js), every matching row,
// refused past the row limit. Example: Employee = Maria, Periods Oct 1-15 ->
// her payroll, its deductions and the attendance lines behind it.

import { tableSheet } from "../../../../shared/exports.js";
import { householdStaffQuery, attendanceQuery, payrollsQuery, advancesQuery } from "../../../../shared/list-queries.js";
import { ATTENDANCE_STATUSES, PAY_CYCLES, PAYROLL_STATUSES, RECEIPT_STATUSES, ADVANCE_STATUSES, SALARY_METHODS, weekdayLabel } from "../../../../shared/payroll.js";

const label = (map, key) => map[key]?.label ?? key ?? "";

const STAFF_COLUMNS = [
  { header: "Name", format: "text", width: 24, value: (s) => s.name },
  { header: "Position", format: "text", width: 18, value: (s) => s.position },
  { header: "Daily wage", format: "money", width: 12, value: (s) => s.dailyWage },
  { header: "Pay cycle", format: "text", width: 26, value: (s) => label(PAY_CYCLES, s.payCycle) },
  { header: "Phone", format: "text", width: 16, value: (s) => s.phone },
  { header: "Start date", format: "date", width: 12, value: (s) => s.startDate },
  { header: "Status", format: "text", width: 10, value: (s) => (s.status === "active" ? "Active" : "Inactive") },
];

const ATTENDANCE_COLUMNS = [
  { header: "Date", format: "date", width: 12, value: (a) => a.date },
  { header: "Day", format: "text", width: 6, value: (a) => weekdayLabel(a.date) },
  { header: "Employee", format: "text", width: 22, value: (a) => a.staffName },
  { header: "Status", format: "text", width: 16, value: (a) => label(ATTENDANCE_STATUSES, a.status) },
  { header: "Daily wage", format: "money", width: 12, value: (a) => a.dailyWage },
  { header: "Payable amount", format: "money", width: 14, value: (a) => a.payableAmount },
  { header: "Notes", format: "text", width: 30, value: (a) => a.note },
];

const PAYROLL_COLUMNS = [
  { header: "Employee", format: "text", width: 22, value: (p) => p.staffName },
  { header: "Period start", format: "date", width: 12, value: (p) => p.periodStart },
  { header: "Period end", format: "date", width: 12, value: (p) => p.periodEnd },
  { header: "Daily wage", format: "money", width: 12, value: (p) => p.dailyWage },
  { header: "Present", format: "integer", width: 9, value: (p) => p.present },
  { header: "Official Leave", format: "integer", width: 9, value: (p) => p.officialLeave },
  { header: "Absent", format: "integer", width: 9, value: (p) => p.absent },
  { header: "Not marked", format: "integer", width: 9, value: (p) => p.notMarked },
  { header: "Payable days", format: "integer", width: 9, value: (p) => p.payableDays },
  { header: "Base pay", format: "money", width: 13, value: (p) => p.basePay },
  { header: "Deductions", format: "money", width: 13, value: (p) => p.deductionsTotal },
  { header: "Net pay", format: "money", width: 13, value: (p) => p.netPay },
  { header: "Salary", format: "text", width: 12, value: (p) => label(PAYROLL_STATUSES, p.status) },
  { header: "Paid date", format: "date", width: 12, value: (p) => p.salary?.paidDate ?? null },
  { header: "Method", format: "text", width: 14, value: (p) => (p.salary ? label(SALARY_METHODS, p.salary.method) : "") },
  { header: "Reference", format: "text", width: 16, value: (p) => p.salary?.reference ?? null },
  { header: "Receipt", format: "text", width: 22, value: (p) => label(RECEIPT_STATUSES, p.receiptStatus) },
];

const DEDUCTION_COLUMNS = [
  { header: "Employee", format: "text", width: 22, value: (d) => d.staffName },
  { header: "Period start", format: "date", width: 12, value: (d) => d.periodStart },
  { header: "Type", format: "text", width: 10, value: (d) => (d.type === "advance" ? "Advance" : "Deduction") },
  { header: "Description", format: "text", width: 34, value: (d) => d.description },
  { header: "Amount", format: "money", width: 13, value: (d) => d.amount },
];

const ADVANCE_COLUMNS = [
  { header: "Date", format: "date", width: 12, value: (a) => a.date },
  { header: "Employee", format: "text", width: 22, value: (a) => a.staffName },
  { header: "Description", format: "text", width: 30, value: (a) => a.description },
  { header: "Amount", format: "money", width: 13, value: (a) => a.amount },
  { header: "Status", format: "text", width: 13, value: (a) => label(ADVANCE_STATUSES, a.status) },
  { header: "Paid date", format: "date", width: 12, value: (a) => a.paidDate },
  { header: "Method", format: "text", width: 14, value: (a) => (a.method ? label(SALARY_METHODS, a.method) : "") },
  { header: "Reference", format: "text", width: 16, value: (a) => a.reference },
  { header: "Deducted", format: "bool", width: 10, value: (a) => a.deducted === true },
];

async function householdStaff({ filters, timezone, readRows }) {
  const rows = await readRows("householdStaff", householdStaffQuery(filters));
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Household Staff", columns: STAFF_COLUMNS, rows, timezone })] };
}

async function attendance({ filters, timezone, readRows }) {
  const rows = await readRows("attendance", attendanceQuery(filters));
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Attendance", columns: ATTENDANCE_COLUMNS, rows, timezone })] };
}

// Payroll + its deductions + the attendance lines of the exported periods
// (ONE attendance query over the overall date range, then matched to each
// payroll: no query per payroll).
async function payroll({ filters, timezone, readRows }) {
  const rows = await readRows("payrolls", payrollsQuery(filters));
  const deductions = rows.flatMap((p) => (p.deductions || []).map((d) => ({ ...d, staffName: p.staffName, periodStart: p.periodStart })));
  let lines = [];
  if (rows.length) {
    const from = rows.reduce((m, p) => (p.periodStart < m ? p.periodStart : m), rows[0].periodStart);
    const to = rows.reduce((m, p) => (p.periodEnd > m ? p.periodEnd : m), rows[0].periodEnd);
    const covered = (a) => rows.some((p) => p.staffId === a.staffId && a.date >= p.periodStart && a.date <= p.periodEnd);
    lines = (await readRows("attendance", attendanceQuery({ staffId: filters.staffId, from, to }))).filter(covered);
  }
  return {
    rowCount: rows.length,
    sheets: [tableSheet({ name: "Payroll", columns: PAYROLL_COLUMNS, rows, timezone }), tableSheet({ name: "Deductions", columns: DEDUCTION_COLUMNS, rows: deductions, timezone }), tableSheet({ name: "Attendance", columns: ATTENDANCE_COLUMNS, rows: lines, timezone })],
    note: "Base pay = the daily wage of each Present or Official Leave day. Net pay = base pay - deductions.",
  };
}

async function advances({ filters, timezone, readRows }) {
  const rows = await readRows("advances", advancesQuery(filters));
  return { rowCount: rows.length, sheets: [tableSheet({ name: "Advances", columns: ADVANCE_COLUMNS, rows, timezone })] };
}

export const PAYROLL_BUILDERS = Object.freeze({ householdStaff, attendance, payroll, advances });
