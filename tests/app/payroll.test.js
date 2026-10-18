// @vitest-environment jsdom
// Phase 14 screens: Attendance (inline status, the period totals), Payroll
// (rows, release -> one-time receipt link), Advances (controlled status ->
// mark paid), Household Staff, the public receipt page, and navigation.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountAttendance } from "../../src/modules/attendance/index.js";
import { mount as mountPayroll, recentPeriods, receiptUrl } from "../../src/modules/payroll/index.js";
import { mount as mountAdvances } from "../../src/modules/advances/index.js";
import { mount as mountStaff } from "../../src/modules/household/index.js";
import { renderReceiptPage } from "../../src/app/receipt.js";
import { buildRoutes } from "../../src/app/routes.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const NOW = () => new Date("2026-10-16T04:00:00Z");
// Waits (up to ~2 s) for a condition instead of a fixed number of ticks.
const until = async (fn) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  return fn();
};
const home = (role = "owner", overrides) => sessionFixture({ roleTemplate: role, workspaceTemplateId: "household-payroll", permissions: overrides ? resolvePermissions(role, overrides) : undefined });
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const submit = (form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

const maria = { id: "staffMaria0001", name: "Maria", position: "Kasambahay", dailyWage: 60000, payCycle: "semi_monthly", status: "active" };
const STATUSES = ["present", "present", "absent", "present", "official_leave", "present", "present", "absent", "present", "present", "official_leave", "present", "absent", "present", "present"];
const lines = STATUSES.map((status, i) => ({ id: `staffMaria0001_2026-10-${String(i + 1).padStart(2, "0")}`, staffId: maria.id, staffName: "Maria", date: `2026-10-${String(i + 1).padStart(2, "0")}`, status, dailyWage: 60000, payableAmount: status === "absent" ? 0 : 60000 }));

// The server's automatic period view (Owner-pilot batch).
const PERIODS = [{ start: "2026-10-16", end: "2026-10-31", current: true }, { start: "2026-10-01", end: "2026-10-15", current: false }, { start: "2026-09-16", end: "2026-09-30", current: false }];
const periodView = (rows, period = { start: "2026-10-01", end: "2026-10-15", state: "ended" }) => ({ view: { today: "2026-10-16", periods: PERIODS, period, rows } });
function fakeData(extra = {}) {
  return {
    activeStaff: vi.fn(async () => [maria]),
    listStaff: vi.fn(async () => ({ rows: [maria], hasMore: false })),
    listAttendance: vi.fn(async (_b, f) => ({ rows: f.staffId ? lines : lines.filter((l) => l.date === f.from), hasMore: false })),
    setAttendance: vi.fn(async () => ({})),
    listPayrolls: vi.fn(async () => ({ rows: [payroll()], hasMore: false })),
    getPayroll: vi.fn(async () => payroll()),
    payrollApi: vi.fn(async (b) => (b.action === "period" ? periodView([payroll()]) : b.action === "release" ? { receiptToken: "tokTOKtokTOKtokTOKtokTOKtokTOKto" } : { payrollId: "staffMaria0001_2026-10-01" })),
    listAdvances: vi.fn(async () => ({ rows: [{ id: "adv0000000001", staffId: maria.id, staffName: "Maria", date: "2026-10-05", amount: 50000, status: "not_yet_paid", description: "Fare" }], hasMore: false })),
    advancesApi: vi.fn(async () => ({})),
    staffApi: vi.fn(async () => ({ staffId: "x" })),
    setAttendanceMany: vi.fn(async (_s, days) => ({ saved: days.map((d) => ({ date: d.date })), failed: [] })),
    attendanceReview: vi.fn(async () => ({ corrections: [], requests: [], confirmation: null })),
    resolveCorrection: vi.fn(async () => ({})),
    ...extra,
  };
}
const payroll = (o = {}) => ({ id: "staffMaria0001_2026-10-01", staffId: maria.id, staffName: "Maria", periodStart: "2026-10-01", periodEnd: "2026-10-15", dailyWage: 60000, present: 10, officialLeave: 2, absent: 3, notMarked: 0, payableDays: 12, basePay: 720000, deductions: [{ id: "adv-x", type: "advance", advanceId: "adv0000000001", description: "Advance 2026-10-05", amount: 50000 }], deductionsTotal: 50000, netPay: 670000, status: "draft", receiptStatus: "none", history: [], ...o });

describe("Attendance (Owner-pilot simplification): one helper, one pay period", () => {
  // Owner-pilot polish (2026-10-16): a calculator-style tap grid.
  const cell = (d) => container.querySelector(`[data-act="cell"][data-day="${d}"]`);
  const tap = async (...days) => {
    for (const d of days) cell(d).click();
    await flush();
  };
  const press = async (status) => {
    container.querySelector(`[data-act="apply"][data-status="${status}"]`).click();
    await flush();
  };
  const choosePeriod = async (start) => {
    const period = container.querySelector('[data-role="pick-period"]');
    period.value = start;
    period.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  };

  it("Employee + Period only; a tap grid of the period's dates with short status labels and a legend; totals", async () => {
    const data = fakeData();
    mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-seg="view"]')).toBeNull();
    expect([...container.querySelectorAll('[data-role="pickers"] select')].map((x) => x.getAttribute("aria-label"))).toEqual(["Employee", "Pay period"]);
    expect(data.listAttendance).toHaveBeenLastCalledWith("demo-distributor-a", { staffId: maria.id, from: "2026-10-16", to: "2026-10-31" }, { pageSize: 100 });
    expect(container.querySelectorAll('[data-role="att-grid"] .att-cell')).toHaveLength(16);
    const period = container.querySelector('[data-role="pick-period"]');
    expect(period.selectedOptions[0].textContent).toBe("Oct 16–31 (now)");
    expect(period.options[0].textContent).toBe("Oct 16–31 (now)"); // nothing ahead: upcoming days can't be marked
    // Upcoming days are shown, not tappable.
    expect(cell("2026-10-17").disabled).toBe(true);
    expect(cell("2026-10-17").classList.contains("is-upcoming")).toBe(true);
    expect(cell("2026-10-16").disabled).toBe(false);
    expect(container.querySelector('[data-role="legend"]').textContent).toMatch(/P Present · A Absent · PL Paid Leave · UL Unpaid Leave · R Rest Day/);
    await choosePeriod("2026-10-01");
    expect(data.listAttendance).toHaveBeenLastCalledWith("demo-distributor-a", { staffId: maria.id, from: "2026-10-01", to: "2026-10-15" }, { pageSize: 100 });
    expect([...container.querySelectorAll(".att-cell .att-st")].map((x) => x.textContent).slice(0, 5)).toEqual(["P", "P", "A", "P", "PL"]);
    expect(container.querySelector('[data-role="totals"]').textContent).toMatch(/Present 10 · Absent 3 · Rest Day 0 · Paid Leave 2 · Unpaid Leave 0 → 12 paid days · ₱7,200\.00/);
  });

  it("tap one date -> tap a status; select several -> one status for all; Clear; nothing sent until Save", async () => {
    const data = fakeData();
    mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    await choosePeriod("2026-10-01");
    // One date.
    await tap("2026-10-03");
    expect(cell("2026-10-03").classList.contains("is-selected")).toBe(true);
    await press("present");
    expect(cell("2026-10-03").querySelector(".att-st").textContent).toBe("P");
    expect(cell("2026-10-03").classList.contains("is-dirty")).toBe(true);
    // Several dates, one status.
    await tap("2026-10-04", "2026-10-11");
    await press("rest_day");
    // Clear a recorded day (back to Not marked).
    await tap("2026-10-13");
    await press("clear");
    expect(cell("2026-10-13").querySelector(".att-st").textContent).toBe("–");
    expect(data.setAttendanceMany).not.toHaveBeenCalled();
    expect(container.querySelector('[data-role="save-bar"]').textContent).toMatch(/4 changes not saved/);
    expect(container.querySelector('[data-role="totals"]').textContent).toMatch(/with unsaved changes/);
    container.querySelector('[data-act="save"]').click();
    await until(() => data.setAttendanceMany.mock.calls.length === 1);
    expect(data.setAttendanceMany).toHaveBeenCalledWith(maria.id, [{ date: "2026-10-03", status: "present" }, { date: "2026-10-04", status: "rest_day" }, { date: "2026-10-11", status: "rest_day" }, { date: "2026-10-13", status: "clear" }]);
  });

  it("Fill normal schedule shows Expected days (upcoming too); Confirm through today stages only days up to today; upcoming never sent", async () => {
    const empty = { ...maria, restDays: [0] };
    const data = fakeData({ activeStaff: vi.fn(async () => [empty]), listAttendance: vi.fn(async () => ({ rows: [], hasMore: false })) });
    mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="fill"]').click();
    await flush();
    // Oct 17 (Sat) expected Present, Oct 18 (Sun) expected Rest Day: shown, not recorded.
    expect(cell("2026-10-17").querySelector(".att-st").textContent).toBe("P?");
    expect(cell("2026-10-18").querySelector(".att-st").textContent).toBe("R?");
    expect(cell("2026-10-18").getAttribute("aria-label")).toMatch(/Expected Rest Day/);
    expect(container.querySelector('[data-role="save-bar"]')).toBeNull();
    container.querySelector('[data-act="confirm-today"]').click();
    await flush();
    expect(container.querySelector('[data-role="save-bar"]').textContent).toMatch(/1 change not saved/);
    container.querySelector('[data-act="save"]').click();
    await until(() => data.setAttendanceMany.mock.calls.length === 1);
    expect(data.setAttendanceMany).toHaveBeenCalledWith(maria.id, [{ date: "2026-10-16", status: "present" }]);
  });

  it("Copy previous period repeats last period's pattern by weekday on unmarked days up to today", async () => {
    const prev = [{ date: "2026-10-09", status: "absent" }, { date: "2026-10-10", status: "rest_day" }]; // a Friday, a Saturday
    const listAttendance = vi.fn(async (_b, f) => ({ rows: f.from === "2026-10-01" ? prev.map((x) => ({ ...x, staffId: maria.id, dailyWage: 60000 })) : [], hasMore: false }));
    const data = fakeData({ listAttendance });
    mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="copy-prev"]').click();
    await flush();
    expect(cell("2026-10-16").querySelector(".att-st").textContent).toBe("A"); // Friday, like Oct 9
    expect(cell("2026-10-17").querySelector(".att-st").textContent).toBe("·"); // upcoming: untouched
    container.querySelector('[data-act="save"]').click();
    await until(() => data.setAttendanceMany.mock.calls.length === 1);
    expect(data.setAttendanceMany).toHaveBeenCalledWith(maria.id, [{ date: "2026-10-16", status: "absent" }]);
  });

  it("correcting a day the helper sent asks for a reason, then saves it with the reason", async () => {
    const data = fakeData({ setAttendanceMany: vi.fn(async (_s, days, reason) => (reason ? { saved: days, failed: [] } : { saved: [], failed: days.map((d) => ({ date: d.date, code: "reason-required", error: "Say why" })) })) });
    mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="cell"][data-day="2026-10-16"]').click();
    await flush();
    container.querySelector('[data-act="apply"][data-status="absent"]').click();
    await flush();
    container.querySelector('[data-act="save"]').click();
    await until(() => lastForm());
    const f = lastForm();
    f.elements.reason.value = "She was on leave";
    submit(f);
    await until(() => data.setAttendanceMany.mock.calls.length === 2);
    expect(data.setAttendanceMany).toHaveBeenLastCalledWith(maria.id, [{ date: "2026-10-16", status: "absent" }], "She was on leave");
  });

  it("Needs review: what the helper reported, compact; Done marks it handled", async () => {
    const data = fakeData({ attendanceReview: vi.fn(async () => ({ corrections: [{ id: "corr00000001", staffId: maria.id, staffName: "Maria", date: "2026-10-08", message: "I was present" }], requests: [], confirmation: { periodStart: "2026-10-16", counts: { present: 0, absent: 0, officialLeave: 0, unpaidLeave: 0, restDay: 0, notMarked: 1 }, confirmedAt: "2026-10-16T05:00:00.000Z" } })) });
    mountAttendance(container, { ...home(), member: { ...home().member } }, { data, now: NOW, toast: () => {} });
    await flush();
    const box = container.querySelector('[data-section="needs-review"]');
    expect(box.textContent.replace(/\s+/g, " ")).toMatch(/Maria\s*· Attendance correction · Oct 8\s*"I was present"/);
    box.querySelector('[data-act="resolve"]').click();
    await flush();
    submit(lastForm());
    await flush();
    expect(data.resolveCorrection).toHaveBeenCalledWith("corr00000001", null);
  });

  it("without attendance.edit the statuses are read-only", async () => {
    mountAttendance(container, home("manager", { revoke: ["attendance.edit"] }), { data: fakeData(), now: NOW });
    await flush();
    expect([...container.querySelectorAll('select[data-act="mark"]')].every((b) => b.disabled)).toBe(true);
    expect(container.querySelector("[data-sel]")).toBeNull();
  });
});

describe("Payroll", () => {
  it("compact row with counts, base, deductions, net, salary and receipt state", async () => {
    mountPayroll(container, home(), { data: fakeData(), now: NOW, toast: () => {} });
    await flush();
    const row = container.querySelector("tr[data-payroll]");
    expect(row.textContent).toMatch(/Maria/);
    expect(row.textContent).toMatch(/10 P · 2 PL · 3 A/);
    expect(row.textContent).toMatch(/₱6,700\.00/);
    // Phase 18.6: the Owner's payment and the employee's confirmation are separate columns.
    expect(row.querySelector('[data-col="payment"]').textContent).toBe("Not paid");
    expect(row.querySelector('[data-col="received"]').textContent).toBe("—");
  });

  it("the payslip: each line says what it is and offers its own actions; Add bonus / 13th month / deduction", async () => {
    const withBonus = payroll({ additions: [{ id: "bon-1", type: "bonus", description: "Christmas", amount: 100000 }], additionsTotal: 100000, grossPay: 820000, netPay: 770000, deductions: [{ id: "adv-adv0000000001", type: "advance", advanceId: "adv0000000001", description: "Advance 2026-10-05", amount: 50000 }, { id: "man-1", type: "manual", description: "Broken plate", amount: 10000 }] });
    const data = fakeData();
    data.payrollApi = vi.fn(async (b) => (b.action === "period" ? periodView([withBonus]) : b.action === "thirteenth" ? { year: 2026, basicPay: 7200000, entitlement: 600000, onPayrolls: 0, remaining: 600000 } : {}));
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="view"]').click();
    await flush();
    const view = document.querySelector('[data-role="payroll-view"]');
    const text = (sel) => [...view.querySelectorAll(`${sel} > li`)].map((li) => [...li.querySelectorAll(".slip-what, .slip-amt")].map((x) => x.childNodes[0].textContent.trim()).join(" "));
    // Owner-pilot polish: one short breakdown (earnings and deductions together).
    expect(text('[data-role="summary"]')).toEqual(["Basic pay ₱7,200.00", "Christmas ₱1,000.00", "Advance deduction − ₱500.00", "Broken plate − ₱100.00"]);
    expect(view.querySelector('[data-role="pay-status"]').textContent).toMatch(/Not paid yet/);
    expect(view.querySelector('[data-role="net"]').textContent).toBe("₱7,700.00");
    // Generated lines are protected: basic pay -> View calculation; advance -> plan actions.
    expect([...view.querySelectorAll('[data-line="basic"] button')].map((b) => b.textContent)).toEqual(["View calculation"]);
    expect([...view.querySelectorAll('[data-advance="adv0000000001"] .menu-item')].map((b) => b.textContent)).toEqual(["View advance", "Edit amount", "Move to another payroll", "Remove from this payroll"]);
    expect([...view.querySelectorAll('[data-addition="bon-1"] .menu-item')].map((b) => b.textContent)).toEqual(["Edit", "Delete"]);
    expect([...view.querySelectorAll('[data-deduction="man-1"] .menu-item')].map((b) => b.textContent)).toEqual(["Edit", "Delete"]);
    view.querySelector('[data-x="calc"]').click();
    await flush();
    const calc = document.querySelector('[data-role="calc"]');
    expect(calc.textContent).toMatch(/10 Present \+ 2 Paid Leave = 12 paid days × ₱600\.00 = ₱7,200\.00/);
    expect(calc.querySelector("a").getAttribute("href")).toBe(`/attendance?staff=${maria.id}&period=2026-10-01`);
    document.querySelector('[data-addition="bon-1"] [data-x="edit-line"]').click();
    let form = lastForm();
    form.elements.amount.value = "1500";
    submit(form);
    await until(() => data.payrollApi.mock.calls.some((c) => c[0].action === "editLine"));
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "editLine", payrollId: "staffMaria0001_2026-10-01", lineId: "bon-1", changes: { amount: 150000, description: "Christmas" } });
    document.querySelector('[data-role="payroll-view"] [data-x="add-13th"]').click();
    form = lastForm();
    submit(form);
    await flush();
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "addAddition", payrollId: "staffMaria0001_2026-10-01", addition: { type: "thirteenth", amount: 600000 } });
    document.querySelector('[data-role="payroll-view"] [data-x="release"]').click();
    document.querySelector('[data-role="payroll-review"] [data-x="continue-pay"]').click();
    form = lastForm();
    expect([...form.elements.method.options].map((o) => o.textContent).slice(0, 3)).toEqual(["Cash", "GCash", "Bank Transfer"]);
    expect(form.elements.proof.accept).toMatch(/application\/pdf/);
  });

  it("Pay salary -> the one-time receipt link is shown (and copyable)", async () => {
    const data = fakeData();
    const copy = vi.fn(async () => {});
    mountPayroll(container, home(), { data, now: NOW, toast: () => {}, copy });
    await flush();
    container.querySelector('[data-act="view"]').click();
    await flush();
    expect(document.querySelector('[data-role="net"]').textContent).toBe("₱6,700.00");
    document.querySelector('[data-x="release"]').click();
    document.querySelector('[data-x="continue-pay"]').click();
    await flush();
    const form = lastForm();
    form.elements.method.value = "gcash";
    await new Promise((r) => setTimeout(r, 750)); // the Pay salary button arms after a moment
    submit(form);
    await until(() => document.querySelector('[data-role="link-text"]'));
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "release", payrollId: "staffMaria0001_2026-10-01", payment: { method: "gcash", paidDate: "2026-10-16" }, expectedNetPay: 670000 });
    expect(document.querySelector('[data-role="paid-success"]').textContent).toMatch(/Paid/);
    expect(document.querySelector('[data-role="link-text"]').value).toBe(receiptUrl("tokTOKtokTOKtokTOKtokTOKtokTOKto"));
    document.querySelector('[data-x="copy"]').click();
    await until(() => copy.mock.calls.length);
    expect(copy).toHaveBeenCalledWith(receiptUrl("tokTOKtokTOKtokTOKtokTOKtokTOKto"));
  });

  it("strict pay flow: Pay opens a read-only Review first; Continue to payment opens the payment details; only Pay salary pays; Back / Close / Cancel never pay; reopening starts at Review", async () => {
    const data = fakeData();
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    const writes = () => data.payrollApi.mock.calls.filter((c) => !["period", "thirteenth"].includes(c[0].action));
    const released = () => data.payrollApi.mock.calls.filter((c) => c[0].action === "release").length;
    const review = () => document.querySelector('[data-role="payroll-review"]');
    // Step 1 -> Step 2: the row's Pay opens Review, no form.
    container.querySelector('[data-act="pay"]').click();
    await until(() => review());
    await flush();
    expect(document.querySelectorAll(".modal-backdrop form")).toHaveLength(0);
    expect(review().querySelector('[data-role="review-who"]').textContent).toMatch(/^Maria · /);
    expect(review().querySelector('[data-line="basic"]').textContent).toMatch(/Basic pay/);
    expect(review().querySelector('[data-role="review-net"]').textContent).toBe("₱6,700.00");
    expect(review().querySelector(".line-menu")).toBeNull(); // read-only
    review().querySelector('[data-x="calc"]').click();
    expect(review().querySelector('[data-role="calc"]')).toBeTruthy();
    expect(writes()).toHaveLength(0); // opening Review changes nothing
    await new Promise((r) => setTimeout(r, 800));
    expect(document.querySelectorAll(".modal-backdrop form")).toHaveLength(0); // never auto-advances
    // Close: nothing paid; Pay again starts at Review.
    review().querySelector('[data-x="close"]').click();
    await flush();
    expect(review()).toBeNull();
    expect(writes()).toHaveLength(0);
    container.querySelector('[data-act="pay"]').click();
    await until(() => review());
    // Step 3: Continue to payment opens the payment details.
    review().querySelector('[data-x="continue-pay"]').click();
    await flush();
    let form = lastForm();
    const btn = form.querySelector('[data-action="submit"]');
    expect(btn.textContent).toBe("Pay salary");
    expect(form.querySelector('[data-action="cancel"]').textContent).toBe("Back");
    expect(btn.disabled).toBe(true); // arming: the opening tap can't press it
    submit(form); // a tap carried over from Review
    await flush();
    expect(released()).toBe(0);
    // One payment form at a time.
    review().querySelector('[data-x="continue-pay"]').click();
    await flush();
    expect(document.querySelectorAll(".modal-backdrop form")).toHaveLength(1);
    // Back: returns to Review, unpaid.
    form.querySelector('[data-action="cancel"]').click();
    await flush();
    expect(document.querySelectorAll(".modal-backdrop form")).toHaveLength(0);
    expect(review()).toBeTruthy();
    expect(writes()).toHaveLength(0);
    // Step 4 only after the deliberate press; a double tap pays once.
    review().querySelector('[data-x="continue-pay"]').click();
    await flush();
    form = lastForm();
    await new Promise((r) => setTimeout(r, 750));
    expect(form.querySelector('[data-action="submit"]').disabled).toBe(false);
    submit(form);
    submit(form);
    await until(() => document.querySelector('[data-role="link-text"]'));
    expect(released()).toBe(1);
    expect(review()).toBeNull();
    expect(document.querySelector('[data-role="paid-success"]').textContent).toMatch(/Paid ₱6,700\.00 to Maria/);
  });

  it("from the payslip: Pay opens Review; Back returns to the payslip, unpaid", async () => {
    const data = fakeData();
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="view"]').click();
    await flush();
    const pay = document.querySelector('[data-role="payroll-view"] [data-x="release"]');
    expect(pay.textContent).toBe("Pay");
    pay.click();
    const back = document.querySelector('[data-role="payroll-review"] [data-x="review-back"]');
    expect(back.textContent).toBe("Back");
    back.click();
    expect(document.querySelector('[data-role="payroll-review"]')).toBeNull();
    expect(document.querySelector('[data-role="payroll-view"]')).toBeTruthy();
    expect(data.payrollApi.mock.calls.some((c) => c[0].action === "release")).toBe(false);
  });

  it("a household member without payroll.release can't pay; an advance deduction offers its plan actions", async () => {
    mountPayroll(container, home("manager", { revoke: ["payroll.release"] }), { data: fakeData(), now: NOW });
    await flush();
    container.querySelector('[data-act="view"]').click();
    await flush();
    expect(document.querySelector('[data-x="release"]')).toBeNull();
    expect(document.querySelector('[data-x="adv-move"]')).not.toBeNull();
  });

  it("a deduction not taken (salary paid without it) stays visible with Move / Mark repaid; the paid salary is unchanged", async () => {
    const paid = payroll({ status: "released", ownerPayment: "paid", receiptStatus: "awaiting", deductions: [], deductionsTotal: 0, netPay: 720000, salary: { amount: 720000, paidDate: "2026-10-12", method: "cash" }, notTaken: [{ advanceId: "adv0000000001", amount: 60000, description: "Advance 2026-10-05" }] });
    const data = fakeData({ payrollApi: vi.fn(async (b) => (b.action === "period" ? periodView([paid]) : {})) });
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="view"]').click();
    await flush();
    const line = document.querySelector('[data-not-taken="adv0000000001"]');
    expect(line.textContent).toMatch(/Scheduled deduction not taken[\s\S]*still owed[\s\S]*₱600\.00/);
    expect([...line.querySelectorAll(".menu-item")].map((b) => b.textContent)).toEqual(["Move to next payroll", "Mark repaid separately", "Edit repayment plan"]);
    expect(document.querySelector('[data-role="payment"]').textContent).toMatch(/₱7,200\.00 on Oct 12/);
    line.querySelector('[data-x="nt-move"]').click();
    await until(() => data.payrollApi.mock.calls.some((c) => c[0].action === "deferAdvance"));
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "deferAdvance", payrollId: "staffMaria0001_2026-10-01", advanceId: "adv0000000001" });
  });

  it("a paid salary is corrected (never erased): only what changed, with a reason", async () => {
    const paid = payroll({ status: "released", ownerPayment: "paid", receiptStatus: "awaiting", salary: { amount: 670000, paidDate: "2026-10-12", method: "cash", reference: null } });
    const data = fakeData({ payrollApi: vi.fn(async (b) => (b.action === "period" ? periodView([paid]) : {})) });
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="view"]').click();
    await flush();
    expect(document.querySelector('[data-x="delete"]')).toBeNull();
    document.querySelector('[data-x="correct"]').click();
    const f = lastForm();
    f.elements.method.value = "gcash";
    f.elements.reason.value = "It was GCash";
    submit(f);
    await until(() => data.payrollApi.mock.calls.some((c) => c[0].action === "correctPayment"));
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "correctPayment", payrollId: "staffMaria0001_2026-10-01", correction: { method: "gcash" }, reason: "It was GCash" });
  });

  it("Employee filter: one helper's periods only (no status / type filters)", async () => {
    const data = fakeData();
    mountPayroll(container, home(), { data, now: NOW });
    await flush();
    expect([...container.querySelectorAll('[data-role="pickers"] select')].map((x) => x.getAttribute("aria-label"))).toEqual(["Employee", "Pay period"]);
    expect(container.querySelector('[data-seg]')).toBeNull();
    const who = container.querySelector('[data-role="pick-staff"]');
    who.value = maria.id;
    who.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(data.payrollApi).toHaveBeenLastCalledWith({ action: "period", staffId: maria.id });
  });

  it("recent periods follow the cycle", () => {
    expect(recentPeriods("semi_monthly", "2026-10-16", 3).map((p) => p.start)).toEqual(["2026-10-16", "2026-10-01", "2026-09-16"]);
    expect(recentPeriods("weekly", "2026-10-16", 2).map((p) => p.start)).toEqual(["2026-10-12", "2026-10-05"]);
  });
});

describe("Advances", () => {
  it("Give an advance: one step (released now) with the method; the summary shows what's owed and planned", async () => {
    const owed = { id: "adv0000000009", staffId: maria.id, staffName: "Maria", date: "2026-10-02", paidDate: "2026-10-02", amount: 110000, deductedAmount: 0, status: "paid", receipt: { state: "awaiting" }, schedule: [{ id: "a", periodStart: "2026-10-16", periodEnd: "2026-10-31", amount: 60000, state: "planned" }, { id: "b", periodStart: "2026-11-01", periodEnd: "2026-11-15", amount: 50000, state: "planned" }] };
    const data = fakeData({ listAdvances: vi.fn(async () => ({ rows: [owed], hasMore: false })), advancesApi: vi.fn(async () => ({ advanceId: "x", schedule: [{ periodStart: "2026-10-16", periodEnd: "2026-10-31", amount: 200000, state: "planned" }], outstanding: 310000, available: null })) });
    mountAdvances(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    const card = container.querySelector(`[data-owe="${maria.id}"]`).textContent.replace(/\s+/g, " ");
    expect(card).toMatch(/Outstanding\s*₱1,100\.00\s*Next deduction\s*₱600\.00\s*· Oct 16–31/);
    expect(container.querySelector('[data-advance="adv0000000009"]').textContent.replace(/\s+/g, " ")).toMatch(/₱1,100\.00 · Oct 2[\s\S]*₱1,100\.00 owed · Deduct ₱600\.00 Oct 16–31 · ₱500\.00 Nov 1–15[\s\S]*Not confirmed/);
    // Owner-pilot UX: the helper card is the working area (advances inside it), no "Open advances"; Voided records outside.
    const owe = container.querySelector(`[data-owe="${maria.id}"]`);
    expect(owe.querySelector('[data-advance="adv0000000009"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/Open advances/);
    expect([...owe.querySelectorAll(".adv-card-actions > .btn, .adv-card-actions > details > summary")].map((b) => b.textContent.trim())).toEqual(["Give advance", "⋯ More"]);
    expect(container.querySelector('[data-act="voided"]').closest("[data-owe]")).toBeNull();
    expect(container.querySelector('[data-act="voided"]').closest(".card")).toBeNull();
    // Owner-pilot polish: Helper, Amount, Deduct on; the rest under More options.
    container.querySelector('[data-act="give"]').click();
    const f = lastForm();
    expect([...f.querySelectorAll(".field label")].slice(0, 3).map((l) => l.textContent)).toEqual(["Helper", "Amount (₱) *", "Deduct on"]);
    expect([...f.elements.plan.options].map((o) => o.textContent)).toEqual(["Next unpaid payroll", "Split repayment", "No payroll deduction"]);
    expect(f.elements.method.closest("details")).not.toBeNull(); // More options
    f.elements.amount.value = "2000";
    f.elements.method.value = "gcash";
    submit(f);
    await flush();
    expect(data.advancesApi).toHaveBeenCalledWith({ action: "give", advance: { staffId: maria.id, date: "2026-10-16", amount: 200000, method: "gcash", plan: "next" } });
    // The quick result.
    const res = document.querySelector('[data-role="advance-result"]');
    expect(res.textContent.replace(/\s+/g, " ")).toMatch(/Advance given\s*₱2,000\.00[\s\S]*Next deduction\s*₱2,000\.00\s*Oct 16–31[\s\S]*Waiting for confirmation/);
  });

  it("Give an advance: the limit is shown and checked before sending; No payroll deduction; ?give=1&staff opens it preselected", async () => {
    localStorage.clear(); // the last-used method is remembered per device
    const limited = { ...maria, advanceLimit: 300000 };
    const owed = { id: "adv0000000009", staffId: maria.id, staffName: "Maria", date: "2026-10-02", paidDate: "2026-10-02", amount: 100000, deductedAmount: 0, status: "paid", schedule: [] };
    const data = fakeData({ activeStaff: vi.fn(async () => [limited]), listAdvances: vi.fn(async () => ({ rows: [owed], hasMore: false })), advancesApi: vi.fn(async () => ({ advanceId: "x", schedule: [], outstanding: 150000, available: 150000 })) });
    window.history.replaceState({}, "", `/advances?give=1&staff=${maria.id}`);
    mountAdvances(container, home(), { data, now: NOW, toast: () => {} });
    await until(() => lastForm()?.elements.plan);
    const f = lastForm();
    expect(f.closest(".modal-backdrop").textContent).toMatch(/Available to advance: ₱2,000\.00/);
    expect(f.elements.staffId.value).toBe(maria.id);
    f.elements.amount.value = "2500";
    submit(f);
    await flush();
    expect(f.closest(".modal-backdrop").textContent).toMatch(/Maximum available is ₱2,000\.00\./);
    expect(data.advancesApi).not.toHaveBeenCalled();
    f.elements.amount.value = "500";
    f.elements.plan.value = "none";
    submit(f);
    await flush();
    expect(data.advancesApi).toHaveBeenCalledWith({ action: "give", advance: { staffId: maria.id, date: "2026-10-16", amount: 50000, method: "cash", plan: "none" } });
    expect(document.querySelector('[data-role="advance-result"]').textContent).toMatch(/None planned/);
    window.history.replaceState({}, "", "/");
  });

  it("⋯ Edit repayment plan sends the plan; Record a repayment sends the amount (the debt only drops by repayment)", async () => {
    const owed = { id: "adv0000000009", staffId: maria.id, staffName: "Maria", date: "2026-10-02", paidDate: "2026-10-02", amount: 110000, deductedAmount: 0, status: "paid", schedule: [{ id: "a", periodStart: "2026-10-16", periodEnd: "2026-10-31", amount: 110000, state: "planned" }] };
    const data = fakeData({ listAdvances: vi.fn(async () => ({ rows: [owed], hasMore: false })) });
    mountAdvances(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-x="plan"]').click();
    let f = lastForm();
    f.elements["2026-10-16"].value = "600";
    f.elements["2026-11-01"].value = "500";
    submit(f);
    await flush();
    expect(data.advancesApi).toHaveBeenCalledWith({ action: "schedule", advanceId: "adv0000000009", schedule: [{ periodStart: "2026-10-16", amount: 60000, state: "planned" }, { periodStart: "2026-11-01", amount: 50000, state: "planned" }] });
    container.querySelector('[data-x="repay"]').click();
    f = lastForm();
    f.elements.amount.value = "500";
    submit(f);
    await flush();
    expect(data.advancesApi).toHaveBeenLastCalledWith({ action: "repay", advanceId: "adv0000000009", repayment: { amount: 50000, date: "2026-10-16", method: "cash" } });
  });
});

describe("Household Staff", () => {
  it("lists people with their daily wage and cycle; adding sends centavos", async () => {
    const data = fakeData();
    mountStaff(container, home(), { data, toast: () => {} });
    await flush();
    expect(container.querySelector("tr[data-staff]").textContent).toMatch(/Maria[\s\S]*₱600\.00[\s\S]*Semi-monthly/);
    container.querySelector('[data-act="new"]').click();
    await flush();
    const form = lastForm();
    form.elements.name.value = "Lito";
    form.elements.dailyWage.value = "650.50";
    form.elements.payCycle.value = "weekly";
    submit(form);
    await flush();
    expect(data.staffApi).toHaveBeenCalledWith({ action: "create", staff: { name: "Lito", position: null, dailyWage: 65050, payCycle: "weekly", cutoffs: null, advanceLimit: null, paidLeaveDays: null, restDays: [0], phone: null, startDate: null, endDate: null, notes: null } });
  });

  it("Owner-pilot batch: custom cutoffs (14 and 29) and a ₱5,000 advance limit", async () => {
    const data = fakeData();
    mountStaff(container, home(), { data, toast: () => {} });
    await flush();
    container.querySelector('[data-act="new"]').click();
    await flush();
    const form = lastForm();
    form.elements.name.value = "Yanie";
    form.elements.dailyWage.value = "411";
    form.elements.cutoffs.value = "14 and 29";
    form.elements.advanceLimit.value = "5000";
    submit(form);
    await flush();
    expect(data.staffApi).toHaveBeenCalledWith({ action: "create", staff: expect.objectContaining({ name: "Yanie", dailyWage: 41100, payCycle: "semi_monthly", cutoffs: [14, 29], advanceLimit: 500000 }) });
    // Blank cutoffs = 1–15 / 16–end; 0 = no advances.
    container.querySelector('[data-act="new"]').click();
    await flush();
    const f2 = lastForm();
    f2.elements.name.value = "Riza";
    f2.elements.dailyWage.value = "500";
    f2.elements.advanceLimit.value = "0";
    submit(f2);
    await flush();
    expect(data.staffApi).toHaveBeenLastCalledWith({ action: "create", staff: expect.objectContaining({ name: "Riza", cutoffs: null, advanceLimit: 0 }) });
  });
});

describe("Household Staff: ⋯ Delete (added by mistake)", () => {
  it("asks first, then deletes; a refusal (has history) shows the server's message", async () => {
    const data = fakeData();
    const toast = vi.fn();
    mountStaff(container, home(), { data, toast, confirm: async () => true });
    await flush();
    container.querySelector('[data-act="row-menu"]').click();
    container.querySelector('.menu-item[data-act="delete"]').click();
    await flush();
    expect(data.staffApi).toHaveBeenCalledWith({ action: "delete", staffId: maria.id });
    data.staffApi.mockRejectedValueOnce(new Error("This person has attendance, payroll or advances. Deactivate them instead"));
    container.querySelector('.menu-item[data-act="delete"]').click();
    await flush();
    expect(toast).toHaveBeenLastCalledWith(expect.stringMatching(/Deactivate them instead/), "danger");
  });

  it("cancelling the confirmation sends nothing; staff without household.manage get no menu", async () => {
    const data = fakeData();
    mountStaff(container, home(), { data, toast: () => {}, confirm: async () => false });
    await flush();
    container.querySelector('.menu-item[data-act="delete"]').click();
    await flush();
    expect(data.staffApi).not.toHaveBeenCalledWith(expect.objectContaining({ action: "delete" }));
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    mountStaff(container, home("manager", { revoke: ["household.manage"] }), { data: fakeData(), toast: () => {} });
    await flush();
    expect(container.querySelector('[data-act="row-menu"]')).toBeNull();
  });
});

describe("public receipt page", () => {
  const receipt = { businessName: "Santos Household", employeeName: "Maria", period: { start: "2026-10-01", end: "2026-10-15" }, amount: 670000, method: "GCash", paidDate: "2026-10-16", receiptStatus: "awaiting", expired: false };
  it("shows only what was paid and confirms once", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      return { ok: true, json: async () => ({ receipt: body.action === "confirm" ? { ...receipt, receiptStatus: "confirmed", confirmed: true } : receipt }) };
    });
    await renderReceiptPage(container, { token: "tokTOKtokTOKtokTOKtokTOK", fetchImpl });
    expect(container.querySelector('[data-role="amount"]').textContent).toBe("₱6,700.00");
    expect(container.textContent).toMatch(/Santos Household/);
    container.querySelector('[data-act="confirm"]').click();
    await flush();
    expect(calls).toEqual([{ action: "view", token: "tokTOKtokTOKtokTOKtokTOK" }, { action: "confirm", token: "tokTOKtokTOKtokTOKtokTOK" }]);
    expect(container.textContent).toMatch(/receipt confirmed/i);
  });
  it("an invalid or missing link says so", async () => {
    await renderReceiptPage(container, { token: "", fetchImpl: vi.fn() });
    expect(container.querySelector('[data-role="message"]').textContent).toMatch(/isn't valid/);
    await renderReceiptPage(container, { token: "nope", fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ message: "This link isn't valid. Ask your employer for a new one." }) }) });
    expect(container.querySelector('[data-role="message"]').textContent).toMatch(/isn't valid/);
  });
});

describe("navigation", () => {
  it("household owners get the payroll pages; Distributor users never do", () => {
    const paths = (s) => buildRoutes(s).map((r) => r.path);
    expect(paths(home())).toEqual(expect.arrayContaining(["/attendance", "/payroll", "/advances", "/household-staff"]));
    expect(paths(sessionFixture({ roleTemplate: "owner" }))).not.toEqual(expect.arrayContaining(["/payroll"]));
    expect(paths(home("staff"))).not.toContain("/payroll");
  });
});

describe("Payroll: automatic pay periods (Owner-pilot batch)", () => {
  const auto = (o = {}) => payroll({ id: "staffMaria0001_2026-10-16", periodStart: "2026-10-16", periodEnd: "2026-10-31", present: 1, officialLeave: 0, absent: 0, payableDays: 1, basePay: 60000, deductions: [], deductionsTotal: 0, netPay: 60000, automatic: true, ...o });
  it("opens on the server's current period with everyone on payroll; no Prepare button; switching period asks for that period", async () => {
    const data = fakeData({ payrollApi: vi.fn(async (b) => (b.action === "period" ? periodView([auto()], b.period ? { ...b.period, state: "ended" } : { start: "2026-10-16", end: "2026-10-31", state: "in_progress" }) : {})) });
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    expect(data.payrollApi.mock.calls[0][0]).toEqual({ action: "period" });
    expect(container.querySelector('[data-act="prepare"]')).toBeNull();
    const sel = container.querySelector('[data-role="period-select"]');
    expect([...sel.options].map((o) => o.textContent)).toEqual(["Oct 16–31 (now)", "Oct 1–15", "Sep 16–30"]);
    expect(container.querySelector('[data-role="period-state"]').textContent).toMatch(/In progress.*Ends Oct 31/);
    expect(container.querySelector("tr[data-payroll]").textContent).toMatch(/Maria[\s\S]*₱600\.00/);
    sel.value = "2026-09-16_2026-09-30";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(data.payrollApi).toHaveBeenLastCalledWith({ action: "period", period: { start: "2026-09-16", end: "2026-09-30" } });
  });
  it("an automatic row: Pay sends staff + period (stored once by the server), labelled Early salary payment while the period is ongoing", async () => {
    const data = fakeData({ getPayroll: vi.fn(async () => null), payrollApi: vi.fn(async (b) => (b.action === "period" ? periodView([auto()], { start: "2026-10-16", end: "2026-10-31", state: "in_progress" }) : b.action === "release" ? { payrollId: "staffMaria0001_2026-10-16", paymentTiming: "early", receiptToken: "tokTOKtokTOKtokTOKtokTOKtokTOKto" } : {})) });
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="view"]').click();
    await flush();
    expect(document.querySelector('[data-role="automatic"]').textContent).toMatch(/Worked out automatically.*still ongoing/);
    document.querySelector('[data-x="release"]').click();
    expect(document.querySelector('[data-role="review-ongoing"]').textContent).toMatch(/still ongoing \(ends Oct 31\)/);
    document.querySelector('[data-x="continue-pay"]').click();
    await flush();
    const form = lastForm();
    expect(document.querySelector(".modal-backdrop:last-child .card-title").textContent).toMatch(/^Early salary payment: Pay ₱600\.00 to Maria/);
    expect(form.textContent).toMatch(/This pay period is still ongoing \(ends Oct 31\)\. Earned through Oct 16: ₱600\.00\. You can also pay the upcoming days now \(prepaid salary, not a cash advance\)/);
    // Prepaid days: by default all upcoming days (Oct 17-31); the Owner can pay fewer, or none.
    const opts = [...form.elements.prepaidDays.options].map((o) => o.textContent);
    expect(form.elements.prepaidDays.value).toBe("15");
    expect(opts[0]).toBe("No, only what's earned so far");
    expect(opts[3]).toBe("3 upcoming days (Oct 17–19): +₱1,800.00");
    form.elements.prepaidDays.value = "3";
    await new Promise((r) => setTimeout(r, 750));
    submit(form);
    await until(() => data.payrollApi.mock.calls.some((c) => c[0].action === "release"));
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "release", staffId: maria.id, periodStart: "2026-10-16", payment: { method: "cash", paidDate: "2026-10-16", prepaidDays: 3 }, expectedNetPay: 60000 });
    expect(data.payrollApi.mock.calls.some((c) => c[0].action === "prepare" || c[0].action === "prepareAll")).toBe(false);
  });
  it("different cutoffs: 'Now (everyone)' shows each person in their own current period", async () => {
    const periods = [{ start: "2026-10-01", end: "2026-10-15", current: true }, { start: "2026-09-30", end: "2026-10-14", current: true }, { start: "2026-09-16", end: "2026-09-30", current: false }];
    const rows = [auto({ id: "staffRiza00001_2026-09-30", staffId: "staffRiza00001", staffName: "Riza", periodStart: "2026-09-30", periodEnd: "2026-10-14" }), auto({ periodStart: "2026-10-01", periodEnd: "2026-10-15" })];
    const data = fakeData({ payrollApi: vi.fn(async (b) => (b.action === "period" ? { view: { today: "2026-10-11", periods, period: { start: "2026-09-30", end: "2026-10-15", state: "in_progress", mixed: true }, rows } } : {})) });
    mountPayroll(container, home(), { data, now: () => new Date("2026-10-11T04:00:00Z"), toast: () => {} });
    await flush();
    const sel = container.querySelector('[data-role="period-select"]');
    expect(sel.value).toBe("current");
    expect(sel.options[0].textContent).toBe("Now (everyone)");
    expect([...container.querySelectorAll("tr[data-payroll] td.cell-strong")].map((td) => td.textContent)).toEqual(["RizaSep 30 – Oct 14", "MariaOct 1–15"]);
    sel.value = "2026-10-01_2026-10-15";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(data.payrollApi).toHaveBeenLastCalledWith({ action: "period", period: { start: "2026-10-01", end: "2026-10-15" } });
    container.querySelector('[data-role="period-select"]').value = "current";
    container.querySelector('[data-role="period-select"]').dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(data.payrollApi).toHaveBeenLastCalledWith({ action: "period", period: { current: true } });
  });

  it("an automatic row: adding a bonus stores the payroll first (prepare), then adds to it", async () => {
    const data = fakeData({ getPayroll: vi.fn(async () => null), payrollApi: vi.fn(async (b) => (b.action === "period" ? periodView([auto()]) : b.action === "prepare" ? { payrollId: "staffMaria0001_2026-10-16" } : {})) });
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="view"]').click();
    await flush();
    document.querySelector('[data-x="add-bonus"]').click();
    const form = lastForm();
    form.elements.amount.value = "200";
    submit(form);
    await until(() => data.payrollApi.mock.calls.some((c) => c[0].action === "addAddition"));
    const actions = data.payrollApi.mock.calls.map((c) => c[0].action).filter((x) => x !== "period" && x !== "thirteenth");
    expect(actions).toEqual(["prepare", "addAddition"]);
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "addAddition", payrollId: "staffMaria0001_2026-10-16", addition: { type: "bonus", amount: 20000 } });
  });
  it("a salary paid early shows earned + prepaid = paid, the final salary, and the difference (additional salary due)", async () => {
    const paid = payroll({ status: "released", paymentTiming: "early", ownerPayment: "paid", receiptStatus: "awaiting", netPay: 730000, salary: { amount: 670000, earned: 610000, prepaid: { days: 1, from: "2026-10-12", to: "2026-10-12", amount: 60000 }, paidDate: "2026-10-11", method: "cash", timing: "early" }, reconcile: { ended: true, waiting: false, paid: 670000, final: 730000, diff: 60000, overpaid: 0, outstanding: 0, additionalDue: 60000, settled: false, carriedTo: [] } });
    const data = fakeData({ getPayroll: vi.fn(async () => paid), payrollApi: vi.fn(async (b) => (b.action === "period" ? periodView([paid]) : {})) });
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    const row = container.querySelector("tr[data-payroll]");
    expect(row.querySelector('[data-col="payment"]').textContent).toBe("Paid early");
    expect(row.textContent).toMatch(/paid ₱6,700\.00/);
    container.querySelector('[data-act="view"]').click();
    await flush();
    const fig = [...document.querySelectorAll('[data-role="early"] dt')].map((dt) => `${dt.textContent.replace(/\s+/g, " ").trim()}: ${dt.nextElementSibling.textContent}`);
    // Owner-pilot polish: Basic pay (earned when paid) − advance + prepaid = total paid; then paid vs final.
    const slip = [...document.querySelectorAll('[data-role="summary"] > li')].map((li) => [...li.querySelectorAll(".slip-what, .slip-amt")].map((x) => x.childNodes[0].textContent.trim()).join(" "));
    expect(slip).toEqual(["Basic pay ₱6,600.00", "Advance deduction − ₱500.00", "Prepaid salary Oct 12 ₱600.00"]);
    expect(document.querySelector('[data-role="net"]').textContent).toBe("₱6,700.00");
    expect(document.querySelector('[data-role="pay-status"]').textContent).toMatch(/Not yet confirmed/);
    expect(fig).toEqual(["Actually paid: ₱6,700.00", "Final salary: ₱7,300.00"]);
    expect(document.querySelector('[data-role="reconcile"]').textContent).toMatch(/Additional salary due\s*₱600\.00 more was earned than paid/);
    document.querySelector('[data-x="pay-additional"]').click();
    const f = lastForm();
    submit(f);
    await until(() => data.payrollApi.mock.calls.some((c) => c[0].action === "payAdditional"));
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "payAdditional", payrollId: paid.id, payment: { amount: 60000, method: "cash", paidDate: "2026-10-16" } });
    // The employee's receipt is still their own step.
    expect(document.querySelector('[data-role="receipt"]').textContent).toMatch(/Not confirmed/);
  });
});

describe("Owner-pilot refinement: salary overpayment on the next payroll", () => {
  it("its own traceable line ('Previous salary overpayment · From Oct 1–15') with View source / Move / Mark repaid / Waive (no Delete)", async () => {
    const next = payroll({ id: "staffMaria0001_2026-10-16", periodStart: "2026-10-16", periodEnd: "2026-10-31", deductions: [{ id: "adv-adv0000000001", type: "advance", advanceId: "adv0000000001", description: "Advance 2026-10-13", amount: 50000 }, { id: "ovp-staffMaria0001_2026-10-01", type: "overpayment", sourcePayrollId: "staffMaria0001_2026-10-01", sourcePeriod: { start: "2026-10-01", end: "2026-10-15" }, description: "Previous salary overpayment", amount: 41100 }], deductionsTotal: 91100 });
    const data = fakeData({ payrollApi: vi.fn(async (b) => (b.action === "period" ? periodView([next], { start: "2026-10-16", end: "2026-10-31", state: "in_progress" }) : {})) });
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="view"]').click();
    await flush();
    const line = document.querySelector('[data-overpayment="staffMaria0001_2026-10-01"]');
    expect(line.textContent).toMatch(/Previous salary overpayment[\s\S]*From Oct 1–15[\s\S]*− ₱411\.00/);
    expect([...line.querySelectorAll(".line-menu-list > *")].map((x) => (x.classList.contains("menu-sep") ? "—" : x.textContent))).toEqual(["View source", "Move to another payroll", "Mark repaid separately", "—", "Waive"]);
    // The advance stays its own line.
    expect(document.querySelector('[data-advance="adv0000000001"]')).not.toBeNull();
    line.querySelector('[data-x="ovp-waive"]').click();
    const f = lastForm();
    f.elements.reason.value = "Goodwill";
    submit(f);
    await until(() => data.payrollApi.mock.calls.some((c) => c[0].action === "overpayment"));
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "overpayment", payrollId: "staffMaria0001_2026-10-01", change: { op: "waive", reason: "Goodwill" } });
  });
});

describe("Owner-pilot change: ⋯ Delete payroll / Void payroll / Delete or Void advance", () => {
  it("payroll rows: View details first; Delete (saved, unpaid) or Void (paid) last, after a separator; none on an unsaved period", async () => {
    const draft = payroll();
    const paid = payroll({ id: "staffRiza00001_2026-10-01", staffId: "staffRiza00001", staffName: "Riza", status: "released", ownerPayment: "paid", receiptStatus: "awaiting", salary: { amount: 670000, paidDate: "2026-10-12", method: "cash" } });
    const auto = payroll({ id: "staffAna000001_2026-10-01", staffId: "staffAna000001", staffName: "Ana", automatic: true });
    const data = fakeData({ payrollApi: vi.fn(async (b) => (b.action === "period" ? periodView([draft, paid, auto]) : {})) });
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    const items = (id) => [...container.querySelectorAll(`tr[data-payroll="${id}"] .line-menu-list > *`)].map((x) => (x.classList.contains("menu-sep") ? "—" : x.textContent));
    expect(items(draft.id)).toEqual(["View details", "—", "Delete payroll"]);
    expect(items(paid.id)).toEqual(["View details", "Correct payroll", "Correct payment", "—", "Void payroll"]);
    // Owner-pilot cleanup: always visible; nothing saved = it explains.
    expect(items(auto.id)).toEqual(["View details", "—", "Delete payroll"]);
    // Delete: a plain confirmation, then deleteDraft.
    container.querySelector(`tr[data-payroll="${draft.id}"] [data-act="delete-payroll"]`).click();
    await flush();
    const dlg = [...document.querySelectorAll(".modal-backdrop")].at(-1);
    expect(dlg.textContent).toMatch(/Delete Maria's Oct 1–15 payroll\?[\s\S]*This removes the saved payroll record and manual payroll entries\. Attendance, Staff and Advances will remain\./);
    dlg.querySelector('[data-action="confirm"], .btn-danger').click();
    await until(() => data.payrollApi.mock.calls.some((c) => c[0].action === "deleteDraft"));
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "deleteDraft", payrollId: draft.id });
  });

  it("void a paid payroll: reason first, then an explicit confirmation", async () => {
    const paid = payroll({ status: "released", ownerPayment: "paid", receiptStatus: "awaiting", salary: { amount: 670000, paidDate: "2026-10-12", method: "cash" } });
    const data = fakeData({ payrollApi: vi.fn(async (b) => (b.action === "period" ? periodView([paid]) : {})) });
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="void-payroll"]').click();
    const f = lastForm();
    expect(f.textContent).toMatch(/This payroll has already been recorded as paid[\s\S]*An audit record of what was originally recorded is kept/);
    f.elements.reason.value = "Entered for the wrong helper";
    submit(f);
    await flush();
    expect(data.payrollApi.mock.calls.some((c) => c[0].action === "void")).toBe(false);
    [...document.querySelectorAll(".modal-backdrop")].at(-1).querySelector('[data-action="confirm"], .btn-danger').click();
    await until(() => data.payrollApi.mock.calls.some((c) => c[0].action === "void"));
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "void", payrollId: paid.id, reason: "Entered for the wrong helper" });
  });

  it("advances: Delete advance (never given) or Delete / Void advance (given, reason) at the bottom", async () => {
    const given = { id: "adv0000000009", staffId: maria.id, staffName: "Maria", date: "2026-10-02", paidDate: "2026-10-02", amount: 200000, deductedAmount: 0, status: "paid", schedule: [] };
    const notGiven = { id: "adv0000000010", staffId: maria.id, staffName: "Maria", date: "2026-10-03", amount: 200000, status: "not_yet_paid" };
    const data = fakeData({ listAdvances: vi.fn(async () => ({ rows: [given, notGiven], hasMore: false })) });
    mountAdvances(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    const items = (id) => [...container.querySelectorAll(`[data-advance="${id}"] .line-menu-list > *`)].map((x) => (x.classList.contains("menu-sep") ? "—" : x.textContent));
    expect(items(given.id).slice(-2)).toEqual(["—", "Delete / Void advance"]);
    expect(items(notGiven.id).slice(-2)).toEqual(["—", "Delete advance"]);
    container.querySelector(`[data-advance="${notGiven.id}"] [data-x="delete"]`).click();
    await flush();
    const dlg = [...document.querySelectorAll(".modal-backdrop")].at(-1);
    expect(dlg.textContent).toMatch(/Delete this ₱2,000\.00 advance\?[\s\S]*No money has been released/);
    dlg.querySelector('[data-action="confirm"], .btn-danger').click();
    await until(() => data.advancesApi.mock.calls.length);
    expect(data.advancesApi).toHaveBeenCalledWith({ action: "delete", advanceId: notGiven.id });
    container.querySelector(`[data-advance="${given.id}"] [data-x="void"]`).click();
    const f = lastForm();
    f.elements.reason.value = "Entered twice";
    submit(f);
    await flush();
    [...document.querySelectorAll(".modal-backdrop")].at(-1).querySelector('[data-action="confirm"], .btn-danger').click();
    await until(() => data.advancesApi.mock.calls.some((c) => c[0].action === "void"));
    expect(data.advancesApi).toHaveBeenCalledWith({ action: "void", advanceId: given.id, reason: "Entered twice" });
  });
});

describe("Owner-pilot cleanup: payroll eligibility, Delete / Correct from ⋯, Paid Leave allowance", () => {
  it("Employee dropdown and Everyone list come from the same server rule: only Loriza, total only hers", async () => {
    const loriza = payroll({ id: "staffLoriza001_2026-10-01", staffId: "staffLoriza001", staffName: "Loriza Ibanez", automatic: true, deductions: [], deductionsTotal: 0, basePay: 493200, netPay: 493200, status: "draft" });
    const view = periodView([loriza], { start: "2026-10-01", end: "2026-10-15", state: "in_progress" });
    view.view.people = [{ id: "staffLoriza001", name: "Loriza Ibanez", active: true }];
    // activeStaff (old source) would still list someone else: the view's list wins.
    const data = fakeData({ activeStaff: vi.fn(async () => [maria, { id: "staffLoriza001", name: "Loriza Ibanez" }]), payrollApi: vi.fn(async (b) => (b.action === "period" ? view : {})) });
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    expect([...container.querySelectorAll('[data-role="pick-staff"] option')].map((o) => o.textContent)).toEqual(["Everyone", "Loriza Ibanez"]);
    expect([...container.querySelectorAll("tr[data-payroll] td.cell-strong")].map((td) => td.textContent.trim())).toEqual(["Loriza Ibanez"]);
    expect(container.querySelector('[data-k="toPay"]').textContent).toBe("₱4,932.00");
  });

  it("Payroll home: the period's Paid / Still to pay / Prepaid (part of paid) at a glance", async () => {
    const early = payroll({ status: "released", paymentTiming: "early", ownerPayment: "paid", receiptStatus: "awaiting", netPay: 610000, salary: { amount: 670000, earned: 610000, prepaid: { days: 1, from: "2026-10-12", to: "2026-10-12", amount: 60000 }, paidDate: "2026-10-11", method: "cash", timing: "early" } });
    const other = payroll({ id: "staffAna000001_2026-10-01", staffId: "staffAna000001", staffName: "Ana", automatic: true, netPay: 300000, deductions: [], deductionsTotal: 0 });
    const data = fakeData({ payrollApi: vi.fn(async (b) => (b.action === "period" ? periodView([early, other]) : {})) });
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    const fig = Object.fromEntries([...container.querySelectorAll('[data-role="pay-figures"] dd')].map((dd) => [dd.dataset.k, dd.textContent]));
    expect(fig).toEqual({ paid: "₱6,700.00", toPay: "₱3,000.00", prepaid: "₱600.00" });
    expect(container.querySelector('[data-role="pay-figures"]').textContent).toMatch(/Prepaid\s*\(in paid\)/);
  });

  it("an automatic (unsaved) payroll: ⋯ Delete payroll explains there's nothing saved and changes nothing", async () => {
    const auto = payroll({ automatic: true });
    const data = fakeData({ payrollApi: vi.fn(async (b) => (b.action === "period" ? periodView([auto]) : {})) });
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="delete-payroll"]').click();
    await flush();
    const dlg = [...document.querySelectorAll(".modal-backdrop")].at(-1);
    expect(dlg.textContent).toMatch(/Nothing saved for Maria's Oct 1–15 payroll[\s\S]*no saved record to delete/);
    dlg.querySelector('[data-action="confirm"], .btn-danger, .btn-primary').click();
    await flush();
    expect(data.payrollApi.mock.calls.some((c) => c[0].action === "deleteDraft")).toBe(false);
  });

  it("a paid payroll: ⋯ Correct payment opens the correction form directly", async () => {
    const paid = payroll({ status: "released", ownerPayment: "paid", receiptStatus: "awaiting", salary: { amount: 670000, paidDate: "2026-10-12", method: "cash" } });
    const data = fakeData({ payrollApi: vi.fn(async (b) => (b.action === "period" ? periodView([paid]) : {})) });
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="correct-payment"]').click();
    await until(() => lastForm()?.elements.reason);
    expect(lastForm().closest(".modal-backdrop").textContent).toMatch(/Correct this payment/);
  });

  it("Attendance shows Paid Leave used / remaining; a used-up allowance asks: Unpaid Leave instead, or override with a reason", async () => {
    const used = { date: "2026-10-16", code: "leave-allowance-used", error: "Paid Leave allowance has been fully used (5 of 5 days in 2026)." };
    const setAttendanceMany = vi.fn(async (_s, days, _reason, override) => (days[0].status === "official_leave" && !override ? { saved: [], failed: [used] } : { saved: days, failed: [] }));
    const data = fakeData({ setAttendanceMany, attendanceReview: vi.fn(async () => ({ corrections: [], requests: [], confirmation: null, leave: { year: 2026, entitled: 5, used: 5, remaining: 0, source: "household" } })) });
    mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-role="leave"]').textContent.replace(/\s+/g, " ")).toMatch(/Paid Leave 2026: used 5 of 5 days · 0 remaining/);
    const mark = async () => {
      container.querySelector('[data-act="cell"][data-day="2026-10-16"]').click();
      await flush();
      container.querySelector('[data-act="apply"][data-status="official_leave"]').click();
      await flush();
      container.querySelector('[data-act="save"]').click();
      await until(() => lastForm()?.elements.choice);
      return lastForm();
    };
    let f = await mark();
    expect(f.closest(".modal-backdrop").textContent).toMatch(/Paid Leave allowance has been fully used\./);
    expect([...f.elements.choice.options].map((o) => o.textContent)).toEqual(["Unpaid Leave instead", "Paid Leave anyway (override)"]);
    submit(f);
    await until(() => setAttendanceMany.mock.calls.length === 2);
    expect(setAttendanceMany).toHaveBeenLastCalledWith(maria.id, [{ date: "2026-10-16", status: "unpaid_leave" }], null, null);
    await flush();
    f = await mark();
    f.elements.choice.value = "override";
    submit(f); // no reason: refused in the form
    await flush();
    expect(setAttendanceMany.mock.calls.length).toBe(3);
    f.elements.reason.value = "Family emergency";
    submit(f);
    await until(() => setAttendanceMany.mock.calls.length === 4);
    expect(setAttendanceMany).toHaveBeenLastCalledWith(maria.id, [{ date: "2026-10-16", status: "official_leave" }], null, "Family emergency");
  });

  it("Household Staff: the household Paid Leave default (Change) and an optional number per helper", async () => {
    const data = fakeData({ staffApi: vi.fn(async (b) => (b.action === "settings" ? { settings: { paidLeaveDays: 5, leaveYear: "calendar" } } : { staffId: "x" })) });
    mountStaff(container, home(), { data, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-role="leave-default"]').textContent.replace(/\s+/g, " ")).toMatch(/Paid Leave allowance: 5 days a year per helper \(Jan–Dec\)/);
    container.querySelector('[data-act="leave-default"]').click();
    let f = lastForm();
    f.elements.days.value = "7";
    submit(f);
    await until(() => data.staffApi.mock.calls.some((c) => c[0].action === "saveSettings"));
    expect(data.staffApi).toHaveBeenCalledWith({ action: "saveSettings", settings: { paidLeaveDays: 7 } });
    await flush();
    container.querySelector('[data-act="new"]').click();
    await flush();
    f = lastForm();
    expect(f.elements.paidLeaveDays.placeholder).toMatch(/Household default/);
    f.elements.name.value = "Lito";
    f.elements.dailyWage.value = "500";
    f.elements.paidLeaveDays.value = "10";
    submit(f);
    await flush();
    expect(data.staffApi).toHaveBeenCalledWith({ action: "create", staff: expect.objectContaining({ name: "Lito", paidLeaveDays: 10 }) });
  });

  it("the deactivate confirmation says payroll stops (current period too) and that the login is separate", async () => {
    const confirm = vi.fn(async () => false);
    const data = fakeData();
    mountStaff(container, home(), { data, toast: () => {}, confirm });
    await flush();
    container.querySelector('.menu-item[data-act="status"]').click();
    await flush();
    expect(confirm.mock.calls[0][0].title).toBe("Deactivate Maria?");
    expect(confirm.mock.calls[0][0].body).toMatch(/stop appearing on Attendance and Payroll, including the current pay period[\s\S]*history stays[\s\S]*managed separately under Users/);
    expect(data.staffApi).not.toHaveBeenCalledWith(expect.objectContaining({ action: "setStatus" }));
  });
});
