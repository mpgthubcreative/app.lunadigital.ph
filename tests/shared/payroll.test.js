// Phase 14 shared payroll logic: pay periods per cycle, the payable-day /
// base-pay calculation, per-line deltas and input validation.

import { describe, it, expect } from "vitest";
import { periodFor, isPeriodOf, daysIn, weekdayLabel, summarizeAttendance, lineContribution, netPayOf, validateStaffInput, validateAttendanceInput, validateAdvanceInput, validateSalaryRelease, validateAdvanceRelease, validateManualDeduction, isValidPayrollId, ATTENDANCE_STATUSES } from "../../shared/payroll.js";

describe("pay periods", () => {
  it("semi-monthly: 1-15 and 16-end (incl. February and leap years)", () => {
    expect(periodFor("semi_monthly", "2026-10-15")).toEqual({ start: "2026-10-01", end: "2026-10-15" });
    expect(periodFor("semi_monthly", "2026-10-16")).toEqual({ start: "2026-10-16", end: "2026-10-31" });
    expect(periodFor("semi_monthly", "2026-02-20")).toEqual({ start: "2026-02-16", end: "2026-02-28" });
    expect(periodFor("semi_monthly", "2028-02-29")).toEqual({ start: "2028-02-16", end: "2028-02-29" });
  });
  it("weekly: Monday to Sunday, across months and years", () => {
    expect(periodFor("weekly", "2026-10-08")).toEqual({ start: "2026-10-05", end: "2026-10-11" }); // Thu
    expect(periodFor("weekly", "2026-10-05")).toEqual({ start: "2026-10-05", end: "2026-10-11" }); // Mon
    expect(periodFor("weekly", "2026-10-11")).toEqual({ start: "2026-10-05", end: "2026-10-11" }); // Sun
    expect(periodFor("weekly", "2027-01-01")).toEqual({ start: "2026-12-28", end: "2027-01-03" });
  });
  it("monthly", () => {
    expect(periodFor("monthly", "2026-11-30")).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(isPeriodOf("monthly", { start: "2026-11-01", end: "2026-11-30" })).toBe(true);
    expect(isPeriodOf("weekly", { start: "2026-11-01", end: "2026-11-07" })).toBe(false);
  });
  it("days and weekday labels; unknown cycles and bad dates are refused", () => {
    expect(daysIn({ start: "2026-10-01", end: "2026-10-15" })).toHaveLength(15);
    expect(weekdayLabel("2026-10-09")).toBe("Fri");
    expect(() => periodFor("daily", "2026-10-01")).toThrow(/pay cycle/);
    expect(() => periodFor("weekly", "2026-13-01")).toThrow(/Invalid date/);
  });
});

describe("the calculation (nobody types base pay)", () => {
  it("Present and Official Leave pay, Absent and unmarked don't; base = sum of each payable day's wage", () => {
    expect(ATTENDANCE_STATUSES.official_leave.payable).toBe(true);
    const lines = [
      ...Array(10).fill({ status: "present", dailyWage: 60000 }),
      ...Array(2).fill({ status: "official_leave", dailyWage: 60000 }),
      ...Array(3).fill({ status: "absent", dailyWage: 60000 }),
    ];
    expect(summarizeAttendance(lines, { start: "2026-10-01", end: "2026-10-15" })).toEqual({ present: 10, absent: 3, officialLeave: 2, unpaidLeave: 0, restDay: 0, notMarked: 0, payableDays: 12, basePay: 720000 });
    // Phase 18.6: Unpaid Leave and Rest Day are counted but not paid.
    const more = [...lines.slice(0, 12), { status: "unpaid_leave", dailyWage: 60000 }, { status: "rest_day", dailyWage: 60000 }, { status: "rest_day", dailyWage: 60000 }];
    expect(summarizeAttendance(more, { start: "2026-10-01", end: "2026-10-15" })).toEqual({ present: 10, absent: 0, officialLeave: 2, unpaidLeave: 1, restDay: 2, notMarked: 0, payableDays: 12, basePay: 720000 });
    expect(ATTENDANCE_STATUSES.official_leave.label).toBe("Paid Leave");
    expect(netPayOf(720000, [{ amount: 50000 }])).toBe(670000);
    // a wage change mid-period: each day keeps the wage it was marked at
    expect(summarizeAttendance([{ status: "present", dailyWage: 60000 }, { status: "present", dailyWage: 65000 }], { start: "2026-10-01", end: "2026-10-02" }).basePay).toBe(125000);
  });
  it("a line's contribution (used for in-place recalculation)", () => {
    expect(lineContribution(null)).toMatchObject({ notMarked: 1, basePay: 0 });
    expect(lineContribution({ status: "official_leave", dailyWage: 600 })).toMatchObject({ officialLeave: 1, payableDays: 1, basePay: 600 });
    expect(lineContribution({ status: "absent", dailyWage: 600 })).toMatchObject({ absent: 1, payableDays: 0, basePay: 0 });
  });
});

describe("validation", () => {
  it("staff: name, wage > 0 and a known cycle; unknown fields refused", () => {
    expect(validateStaffInput({ name: " Maria ", dailyWage: 60000, payCycle: "semi_monthly" })).toMatchObject({ name: "Maria", dailyWage: 60000, payCycle: "semi_monthly", position: null });
    expect(() => validateStaffInput({ name: "M", dailyWage: 0, payCycle: "weekly" })).toThrow();
    expect(() => validateStaffInput({ name: "M", dailyWage: 1, payCycle: "daily" })).toThrow();
    expect(() => validateStaffInput({ name: "M", dailyWage: 1, payCycle: "weekly", status: "active" })).toThrow(/Unknown field/);
    expect(validateStaffInput({ dailyWage: 70000 }, { partial: true })).toEqual({ dailyWage: 70000 });
    // money is integer centavos everywhere: fractions, strings, NaN and Infinity are refused
    for (const bad of [600.5, 0.1, "60000", NaN, Infinity, -60000]) expect(() => validateStaffInput({ name: "M", dailyWage: bad, payCycle: "weekly" }), String(bad)).toThrow();
    for (const bad of [100.25, "500", NaN]) {
      expect(() => validateAdvanceInput({ staffId: "abcdefgh1234", date: "2026-10-09", amount: bad }), String(bad)).toThrow();
      expect(() => validateManualDeduction({ description: "x", amount: bad }), String(bad)).toThrow();
    }
  });
  it("attendance: three statuses, no future", () => {
    expect(() => validateAttendanceInput({ staffId: "abcdefgh1234", date: "2026-10-10", status: "present" }, { today: "2026-10-09" })).toThrow(/future/);
    expect(() => validateAttendanceInput({ staffId: "abcdefgh1234", date: "2026-10-09", status: "day_off" }, { today: "2026-10-09" })).toThrow();
    expect(validateAttendanceInput({ staffId: "abcdefgh1234", date: "2026-10-09", status: "official_leave", note: " sick " }, { today: "2026-10-09" }).note).toBe("sick");
  });
  it("advances and releases", () => {
    expect(() => validateAdvanceInput({ staffId: "abcdefgh1234", date: "2026-10-09", amount: -1 })).toThrow();
    expect(validateAdvanceRelease({}, { today: "2026-10-09" })).toEqual({ paidDate: "2026-10-09", method: "cash", reference: null });
    expect(() => validateSalaryRelease({ method: "cash", paidDate: "2026-10-10" }, { today: "2026-10-09" })).toThrow(/future/);
    expect(isValidPayrollId("abcdefgh1234_2026-10-01")).toBe(true);
    expect(isValidPayrollId("abcdefgh1234_2026-13-01")).toBe(false);
    expect(isValidPayrollId("../x_2026-10-01")).toBe(false);
  });
});
