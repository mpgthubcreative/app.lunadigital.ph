// Luna Household: the Download Excel sheets (shared/workbook.js).
//   Expenses           Date | Category | Expense | Amount: every active
//                      expense in the range, plus each PAID salary once,
//                      under Household Staff ("Payroll · Loriza Ibanez", by
//                      its paid date, the amount actually paid), exactly as
//                      the Expenses screen counts it. Cash advances aren't
//                      spending: never here.
//   Payroll            one row per employee and pay period (recorded
//                      payrolls overlapping the range)
//   Payroll Breakdown  each bonus / 13th month / deduction of those payrolls
//   Attendance         Date | Employee | Status
//   Advances           Date | Employee | Advance | Deducted | Balance | Status
//   Grocery List       the list as it is now
// Each sheet only with its module and view permission.

import { expensesQuery, categoriesQuery, payrollsQuery, attendanceQuery, advancesQuery } from "../../../../shared/list-queries.js";
import { ATTENDANCE_STATUSES, ADVANCE_STATUSES, advanceRemaining } from "../../../../shared/payroll.js";
import { periodText, dayOf, byText } from "./common.js";

const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const sum = (list) => (list || []).reduce((t, x) => t + int(x.amount), 0);
const label = (map, key) => map[key]?.label ?? key ?? "";

const EXPENSE_COLUMNS = [
  { header: "Date", format: "date", width: 14, value: (r) => r.date },
  { header: "Category", format: "text", width: 20, value: (r) => r.category },
  { header: "Expense", format: "text", width: 34, value: (r) => r.name },
  { header: "Amount", format: "money", width: 14, total: true, value: (r) => r.amount },
];
const PAYROLL_COLUMNS = [
  { header: "Period", format: "text", width: 18, value: (p) => periodText(p.periodStart, p.periodEnd) },
  { header: "Employee", format: "text", width: 24, value: (p) => p.staffName },
  { header: "Basic Pay", format: "money", width: 14, total: true, value: (p) => p.basePay },
  { header: "Additions", format: "money", width: 13, total: true, value: (p) => sum(p.additions) },
  { header: "Deductions", format: "money", width: 13, total: true, value: (p) => sum(p.deductions) },
  { header: "Net Pay", format: "money", width: 14, total: true, value: (p) => p.netPay },
  { header: "Status", format: "text", width: 11, value: (p) => (p.status === "released" ? "Paid" : "Not paid") },
  { header: "Date Paid", format: "date", width: 14, value: (p) => (p.status === "released" ? p.salary?.paidDate ?? null : null) },
];
const BREAKDOWN_COLUMNS = [
  { header: "Period", format: "text", width: 18, value: (l) => periodText(l.p.periodStart, l.p.periodEnd) },
  { header: "Employee", format: "text", width: 24, value: (l) => l.p.staffName },
  { header: "Type", format: "text", width: 12, value: (l) => l.type },
  { header: "Description", format: "text", width: 34, value: (l) => l.description },
  { header: "Amount", format: "money", width: 13, value: (l) => l.amount },
];
const ATTENDANCE_COLUMNS = [
  { header: "Date", format: "date", width: 14, value: (a) => a.date },
  { header: "Employee", format: "text", width: 24, value: (a) => a.staffName },
  { header: "Status", format: "text", width: 16, value: (a) => label(ATTENDANCE_STATUSES, a.status) },
];
// Released advances: deducted so far and what's still owed (as of now).
const released = (a) => a.status === "paid";
const ADVANCE_COLUMNS = [
  { header: "Date", format: "date", width: 14, value: (a) => a.date },
  { header: "Employee", format: "text", width: 24, value: (a) => a.staffName },
  { header: "Advance", format: "money", width: 13, total: true, value: (a) => a.amount },
  { header: "Deducted", format: "money", width: 13, total: true, value: (a) => (released(a) ? a.amount - advanceRemaining(a) : null) },
  { header: "Balance", format: "money", width: 13, total: true, value: (a) => (released(a) ? advanceRemaining(a) : null) },
  { header: "Status", format: "text", width: 18, value: (a) => label(ADVANCE_STATUSES, a.status) },
];
const GROCERY_COLUMNS = [
  { header: "Item", format: "text", width: 28, value: (g) => g.name },
  { header: "Quantity", format: "text", width: 12, value: (g) => g.qty },
  { header: "Category", format: "text", width: 18, value: (g) => g.category },
  { header: "Bought", format: "text", width: 9, value: (g) => (g.bought ? "Yes" : "No") },
  { header: "Bought Date", format: "date", width: 14, value: (g) => (g.bought ? g.boughtDay : null) },
];

// The readable name of one expense: payee, its description (notes), the
// bill it paid, then the category.
function expenseName(e, bill, category) {
  return e.payee || e.notes || bill?.description || category || "Expense";
}

const breakdownOf = (p) => [
  ...(p.additions || []).map((a) => ({ p, type: "Addition", description: a.type === "thirteenth" ? `13th month pay ${a.year ?? ""}`.trim() : a.description || "Bonus", amount: a.amount })),
  ...(p.deductions || []).map((d) => ({ p, type: "Deduction", description: d.type === "advance" ? "Advance deduction" : d.type === "overpayment" ? "Previous salary overpayment" : d.description || "Deduction", amount: d.amount })),
];

export async function householdSheets(x) {
  const { from, to } = x.range;
  const dated = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const inRange = (d) => typeof d === "string" && (!from || d >= from) && (!to || d <= to);
  const sheets = [];

  if (x.can("expenses", "expenses.view")) {
    const [rows, cats] = await Promise.all([x.readRows("expenses", expensesQuery({ status: "active", ...dated })), x.readRows("expenseCategories", categoriesQuery())]);
    const names = new Map(cats.map((c) => [c.id, c.name]));
    const bills = await x.readByIds("scheduledPayments", rows.filter((e) => e.scheduleId).map((e) => e.scheduleId));
    const items = rows.map((e) => {
      const category = names.get(e.category) ?? e.categoryName ?? "Other";
      return { date: e.date, category, name: expenseName(e, e.scheduleId ? bills.get(e.scheduleId) : null, category), amount: e.amount };
    });
    // A paid salary is household spending once, under Household Staff.
    if (x.can("payroll", "payroll.view")) {
      for (const p of await x.readRows("payrolls", payrollsQuery({ status: "released" }))) {
        if (inRange(p.salary?.paidDate) && Number.isSafeInteger(p.salary?.amount)) items.push({ date: p.salary.paidDate, category: "Household Staff", name: `Payroll · ${p.staffName ?? ""}`.trim(), amount: p.salary.amount });
      }
    }
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byText(a.category, b.category) || byText(a.name, b.name)));
    sheets.push({ name: "Expenses", columns: EXPENSE_COLUMNS, rows: items });
  }

  if (x.can("payroll", "payroll.view")) {
    // Pay periods overlapping the range (period start up to its end).
    const rows = (await x.readRows("payrolls", payrollsQuery(to ? { to } : {}))).filter((p) => !from || p.periodEnd >= from);
    rows.sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : byText(a.staffName, b.staffName)));
    sheets.push({ name: "Payroll", columns: PAYROLL_COLUMNS, rows });
    sheets.push({ name: "Payroll Breakdown", columns: BREAKDOWN_COLUMNS, rows: rows.flatMap(breakdownOf) });
  }

  if (x.can("attendance", "attendance.view")) {
    const rows = await x.readRows("attendance", attendanceQuery(dated));
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byText(a.staffName, b.staffName)));
    sheets.push({ name: "Attendance", columns: ATTENDANCE_COLUMNS, rows });
  }

  if (x.can("advances", "advances.view")) {
    const rows = await x.readRows("advances", advancesQuery(dated));
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byText(a.staffName, b.staffName)));
    sheets.push({ name: "Advances", columns: ADVANCE_COLUMNS, rows });
  }

  if (x.can("grocery", "grocery.view")) {
    const rows = (await x.readAll("groceryItems")).map((g) => ({ ...g, boughtDay: dayOf(g.boughtAt, x.timezone) }));
    rows.sort((a, b) => Number(Boolean(a.bought)) - Number(Boolean(b.bought)) || byText(a.category, b.category) || byText(a.name, b.name));
    sheets.push({ name: "Grocery List", columns: GROCERY_COLUMNS, rows });
  }
  return sheets;
}
