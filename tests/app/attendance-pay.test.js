// @vitest-environment jsdom
// Household 2026-10-29: Attendance & Pay is the employee workspace. One
// Employee + Period choice drives the attendance calendar AND that cutoff's
// pay (summary, Pay, Payment link, More actions); Everyone lists each helper
// for the cutoff; the cutoff carries over to Payroll and Advances.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountAttendance } from "../../src/modules/attendance/index.js";
import { mount as mountPayroll } from "../../src/modules/payroll/index.js";
import { receiptUrl } from "../../src/modules/payroll/payslip.js";
import { forgetLinks, moreActions } from "../../src/modules/payroll/payslip.js";
import { clearScope, getScope } from "../../src/modules/household/scope.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const until = async (fn) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  return fn();
};
const NOW = () => new Date("2026-10-16T04:00:00Z");
const home = (role = "owner", overrides) => sessionFixture({ roleTemplate: role, workspaceTemplateId: "household-payroll", permissions: overrides ? resolvePermissions(role, overrides) : undefined });
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const submit = (form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
  window.history.replaceState({}, "", "/attendance");
  clearScope();
  forgetLinks();
});

const loriza = { id: "staffLoriza001", name: "Loriza Ibanez", dailyWage: 60000, payCycle: "semi_monthly", status: "active", startDate: "2026-01-01", login: "loriza.1234" };
const ana = { id: "staffAna000001", name: "Ana Reyes", dailyWage: 50000, payCycle: "semi_monthly", status: "active", startDate: "2026-01-01" };
const PERIODS = [{ start: "2026-10-16", end: "2026-10-31", current: true }, { start: "2026-10-01", end: "2026-10-15", current: false }];
const row = (o = {}) => ({ id: "staffLoriza001_2026-10-01", staffId: loriza.id, staffName: "Loriza Ibanez", periodStart: "2026-10-01", periodEnd: "2026-10-15", dailyWage: 60000, present: 10, officialLeave: 2, absent: 3, notMarked: 0, payableDays: 12, basePay: 720000, additions: [{ id: "bon-1", type: "bonus", description: "Performance", amount: 30000 }], additionsTotal: 30000, deductions: [{ id: "adv-a", type: "advance", advanceId: "advA00000001", description: "Advance 2026-10-05", amount: 50000 }, { id: "man-1", type: "manual", description: "Uniform", amount: 15000 }], deductionsTotal: 65000, netPay: 685000, status: "draft", receiptStatus: "none", history: [], ...o });
const paidRow = (o = {}) => row({ status: "released", ownerPayment: "paid", receiptStatus: "awaiting", salary: { amount: 685000, paidDate: "2026-10-15", method: "gcash" }, receiptView: { status: "awaiting", openedAt: null, confirmedAt: null, confirmedBy: null, verifiedVia: null }, ...o });
const view = (rows, period) => ({ view: { today: "2026-10-16", periods: PERIODS, period, rows } });
function fakeData(rows = [row()], extra = {}) {
  return {
    activeStaff: vi.fn(async () => [loriza, ana]),
    listAttendance: vi.fn(async () => ({ rows: [], hasMore: false })),
    attendanceReview: vi.fn(async () => ({ corrections: [], requests: [], confirmation: null })),
    setAttendanceMany: vi.fn(async (_s, days) => ({ saved: days, failed: [] })),
    listAdvances: vi.fn(async () => ({ rows: [], hasMore: false })),
    advancesApi: vi.fn(async () => ({ advanceId: "x", schedule: [], outstanding: 50000, available: null })),
    payrollApi: vi.fn(async (b) => {
      if (b.action === "period") {
        const p = b.period?.start ? { start: b.period.start, end: b.period.end, state: b.period.end < "2026-10-16" ? "ended" : "in_progress" } : { start: "2026-10-16", end: "2026-10-31", state: "in_progress" };
        return view(rows.filter((r) => (!b.staffId || r.staffId === b.staffId) && r.periodStart === p.start), p);
      }
      if (b.action === "newReceiptLink") return { payrollId: b.payrollId, receiptToken: "tokNEWtokNEWtokNEWtokNEWtokNEWto" };
      return {};
    }),
    ...extra,
  };
}
const open = async (data, session = home()) => {
  mountAttendance(container, session, { data, now: NOW, toast: () => {} });
  await flush();
};
const pickPeriod = async (start) => {
  const el = container.querySelector('[data-role="pick-period"]');
  el.value = start;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
};
const figures = () => Object.fromEntries([...container.querySelectorAll('[data-role="pay-figures"] > div')].map((d) => [d.querySelector("dt").textContent, d.querySelector("dd").textContent.trim()]));

describe("Attendance & Pay: one employee, one cutoff", () => {
  it("title, Employee (Everyone + staff) and Period; the cutoff's pay above the calendar, from Payroll's own figures", async () => {
    const data = fakeData();
    await open(data);
    expect(container.querySelector("h1, .page-title").textContent).toMatch(/Attendance & Pay/);
    expect([...container.querySelector('[data-role="pick-staff"]').options].map((o) => o.textContent)).toEqual(["Everyone", "Loriza Ibanez", "Ana Reyes"]);
    await pickPeriod("2026-10-01");
    expect(data.payrollApi).toHaveBeenLastCalledWith({ action: "period", period: { start: "2026-10-01", end: "2026-10-15" }, staffId: loriza.id });
    expect(data.listAttendance).toHaveBeenLastCalledWith(expect.any(String), { staffId: loriza.id, from: "2026-10-01", to: "2026-10-15" }, { pageSize: 100 });
    expect(container.querySelector('[data-role="pay-who"]').textContent).toBe("Loriza Ibanez");
    expect(container.querySelector('[data-role="pay-period"]').textContent).toBe("Oct 1–15 · Ended");
    expect(figures()).toEqual({ "Paid days": "12", "Basic pay": "₱7,200.00", "Advances to deduct": "− ₱500.00", Bonuses: "+ ₱300.00", "Other deductions": "− ₱150.00", "Net pay": "₱6,850.00" });
    expect(container.querySelector('[data-k="payment"]').textContent).toMatch(/Not paid/);
    expect(container.querySelector('[data-k="confirmation"]').textContent).toMatch(/After payment/);
    // The calendar stays the base of the screen (below the summary).
    const summary = container.querySelector('[data-role="pay-summary"]');
    expect(summary.compareDocumentPosition(container.querySelector('[data-role="att-grid"]')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No separate attendance confirmation any more (only the salary's Confirm received).
    expect(container.querySelector('[data-role="confirmation-chip"], [data-role="confirmation"]')).toBeNull();
  });

  it("Pay first (strongest), then Payment link and More actions; Pay opens the payroll's own Review", async () => {
    const data = fakeData();
    await open(data);
    await pickPeriod("2026-10-01");
    const actions = container.querySelector('[data-role="pay-actions"]');
    const pay = actions.querySelector('[data-act="pay"]');
    expect(pay.classList.contains("btn-primary")).toBe(true);
    expect(pay.textContent).toBe("Pay ₱6,850.00");
    expect([...actions.querySelectorAll(".att-pay-row > .btn, .att-pay-row > details > summary")].map((b) => b.textContent.trim())).toEqual(["Payment link", "More actions ▾"]);
    pay.click();
    await until(() => document.querySelector('[data-role="payroll-review"]'));
    expect(document.querySelector('[data-role="review-who"]').textContent).toMatch(/Loriza Ibanez · Oct 1–15/);
    expect(data.payrollApi.mock.calls.some((c) => c[0].action === "release")).toBe(false); // Review never pays
  });

  it("the summary follows the choice: another helper or period updates pay and calendar together", async () => {
    const data = fakeData([row(), row({ id: "staffAna000001_2026-10-01", staffId: ana.id, staffName: "Ana Reyes", basePay: 500000, netPay: 500000, payableDays: 10, deductions: [], deductionsTotal: 0, additions: [], additionsTotal: 0 })]);
    await open(data);
    await pickPeriod("2026-10-01");
    const who = container.querySelector('[data-role="pick-staff"]');
    who.value = ana.id;
    who.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(data.listAttendance).toHaveBeenLastCalledWith(expect.any(String), { staffId: ana.id, from: "2026-10-01", to: "2026-10-15" }, { pageSize: 100 }); // same cutoff
    expect(container.querySelector('[data-role="pay-who"]').textContent).toBe("Ana Reyes");
    expect(figures()["Basic pay"]).toBe("₱5,000.00");
  });

  it("paid: Total paid, Paid early/Paid, Awaiting staff confirmation; no Pay button", async () => {
    await open(fakeData([paidRow({ salary: { amount: 745000, paidDate: "2026-10-12", method: "gcash", prepaid: { days: 1, from: "2026-10-13", to: "2026-10-13", amount: 60000 } }, paymentTiming: "early" })]));
    await pickPeriod("2026-10-01");
    expect(figures()["Prepaid salary"]).toBe("₱600.00");
    expect(figures()["Total paid"]).toBe("₱7,450.00");
    expect(container.querySelector('[data-k="payment"]').textContent).toMatch(/Paid early/);
    expect(container.querySelector('[data-k="confirmation"]').textContent).toBe("Awaiting staff confirmation");
    expect(container.querySelector('[data-act="pay"]')).toBeNull();
  });
});

describe("Payment link", () => {
  it("unpaid: says it's made when paying", async () => {
    await open(fakeData());
    await pickPeriod("2026-10-01");
    container.querySelector('[data-act="paylink"]').click();
    await flush();
    expect(document.querySelector('[data-role="payment-link"] [data-role="link-unpaid"]').textContent).toMatch(/made when you pay Loriza/);
  });

  it("paid, awaiting: Opened / Staff confirmation; Get link makes a fresh secure link (old stops working); Copy", async () => {
    const data = fakeData([paidRow({ receiptView: { status: "awaiting", openedAt: "2026-10-15T08:00:00.000Z", confirmedAt: null } })]);
    const copy = vi.fn(async () => {});
    mountAttendance(container, home(), { data, now: NOW, toast: () => {}, copy });
    await flush();
    await pickPeriod("2026-10-01");
    container.querySelector('[data-act="paylink"]').click();
    await flush();
    const box = () => document.querySelector('[data-role="payment-link"]');
    expect(box().querySelector('[data-role="link-opened"]').textContent).toBe("Oct 15");
    expect(box().querySelector('[data-role="link-confirmation"]').textContent).toBe("Awaiting staff confirmation");
    expect(box().querySelector('[data-role="link-new"]').textContent).toMatch(/Any earlier link stops working/);
    box().querySelector('[data-x="get"]').click();
    await until(() => box().querySelector('[data-role="link-text"]'));
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "newReceiptLink", payrollId: "staffLoriza001_2026-10-01" });
    expect(box().querySelector('[data-role="link-text"]').value).toBe(receiptUrl("tokNEWtokNEWtokNEWtokNEWtokNEWto"));
    expect(box().querySelector('[data-role="link-open"]').getAttribute("href")).toBe(receiptUrl("tokNEWtokNEWtokNEWtokNEWtokNEWto"));
    box().querySelector('[data-x="copy"]').click();
    await until(() => copy.mock.calls.length);
    expect(copy).toHaveBeenCalledWith(receiptUrl("tokNEWtokNEWtokNEWtokNEWtokNEWto"));
  });

  it("confirmed: Confirmed received, no link needed", async () => {
    await open(fakeData([paidRow({ receiptStatus: "confirmed", receiptView: { status: "confirmed", openedAt: "2026-10-15T08:00:00.000Z", confirmedAt: "2026-10-15T10:42:00.000Z", confirmedBy: "Loriza Ibanez" } })]));
    await pickPeriod("2026-10-01");
    expect(container.querySelector('[data-k="confirmation"]').textContent).toBe("Confirmed received");
    container.querySelector('[data-act="paylink"]').click();
    await flush();
    const box = document.querySelector('[data-role="payment-link"]');
    expect(box.querySelector('[data-role="link-done"]').textContent).toMatch(/Loriza confirmed receiving it on Oct 15\. No link needed\./);
    expect(box.querySelector('[data-x="get"]')).toBeNull();
  });
});

describe("More actions (employee level)", () => {
  const menu = () => [...container.querySelectorAll('[data-role="more-actions"] .line-menu-list > *')].map((x) => (x.classList.contains("menu-sep") ? "—" : x.textContent.trim()));

  it("unpaid: Adjustments · History & details (no Void, no Correct)", async () => {
    await open(fakeData());
    await pickPeriod("2026-10-01");
    expect(menu()).toEqual(["Adjustments", "Give advance", "Add bonus", "Add deduction", "Add 13th month pay", "—", "Record", "Delete payroll", "—", "History & details", "Payroll details", "View advances"]);
  });

  it("paid: Correct payroll / payment, Void payroll (destructive, never beside Pay), history and proof", async () => {
    await open(fakeData([paidRow()]));
    await pickPeriod("2026-10-01");
    expect(menu()).toEqual(["Adjustments", "Give advance", "—", "Corrections", "Correct payroll / payment", "—", "Record", "Void payroll", "—", "History & details", "Payroll details", "View advances", "Payment history", "Add payment proof"]);
    expect(container.querySelector('[data-pay-act="void"]').classList.contains("is-danger")).toBe(true);
    expect(container.querySelector('[data-role="pay-actions"] > [data-pay-act="void"]')).toBeNull();
  });

  it("Give advance: the Advances flow, for this helper", async () => {
    const data = fakeData();
    await open(data);
    await pickPeriod("2026-10-01");
    container.querySelector('[data-pay-act="give-advance"]').click();
    await until(() => lastForm()?.elements.amount);
    const f = lastForm();
    expect(f.elements.staffId.value).toBe(loriza.id);
    f.elements.amount.value = "500";
    submit(f);
    await until(() => data.advancesApi.mock.calls.length);
    expect(data.advancesApi).toHaveBeenCalledWith({ action: "give", advance: { staffId: loriza.id, date: "2026-10-16", amount: 50000, method: "cash", plan: "next" }, idempotencyKey: expect.any(String) });
  });

  it("Add bonus / Add deduction open the payroll's own forms (idempotent, the payroll keeps the history)", async () => {
    const data = fakeData();
    await open(data);
    await pickPeriod("2026-10-01");
    container.querySelector('[data-pay-act="add-bonus"]').click();
    await until(() => lastForm()?.elements.amount);
    const f = lastForm();
    f.elements.amount.value = "300";
    f.elements.description.value = "Performance bonus";
    submit(f);
    await until(() => data.payrollApi.mock.calls.some((c) => c[0].action === "addAddition"));
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "addAddition", payrollId: "staffLoriza001_2026-10-01", addition: { type: "bonus", amount: 30000, description: "Performance bonus" }, idempotencyKey: expect.any(String) });
  });

  it("Void payroll: the reason, then an explicit confirmation", async () => {
    const data = fakeData([paidRow()]);
    await open(data);
    await pickPeriod("2026-10-01");
    container.querySelector('[data-pay-act="void"]').click();
    await until(() => lastForm()?.elements.reason);
    const f = lastForm();
    f.elements.reason.value = "Wrong helper";
    submit(f);
    await until(() => [...document.querySelectorAll(".modal-backdrop")].some((b) => /Void this paid payroll\?/.test(b.textContent)));
    const dlg = [...document.querySelectorAll(".modal-backdrop")].at(-1);
    dlg.querySelector('[data-action="confirm"], .btn-danger').click();
    await until(() => data.payrollApi.mock.calls.some((c) => c[0].action === "void"));
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "void", payrollId: "staffLoriza001_2026-10-01", reason: "Wrong helper" });
  });

  it("the groups follow permissions (no money actions without them)", () => {
    const groups = moreActions(paidRow(), { canManage: false, canRelease: false, canAdvances: false });
    expect(groups.map((g) => g.label)).toEqual(["History & details"]);
  });
});

describe("Everyone, and the cutoff carrying over", () => {
  it("Everyone lists each helper for the cutoff; tapping one opens them on the SAME cutoff", async () => {
    const data = fakeData([row(), row({ id: "staffAna000001_2026-10-01", staffId: ana.id, staffName: "Ana Reyes" })]);
    await open(data);
    const who = container.querySelector('[data-role="pick-staff"]');
    who.value = "";
    who.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const ev = container.querySelector('[data-role="pick-ev-period"]');
    ev.value = "2026-10-01_2026-10-15";
    ev.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const people = [...container.querySelectorAll('[data-role="everyone"] .att-person')];
    expect(people.map((b) => b.querySelector("strong").textContent)).toEqual(["Loriza Ibanez", "Ana Reyes"]);
    expect(people[0].textContent).toMatch(/10 P · 2 PL · 3 A/);
    people[1].click();
    await flush();
    expect(container.querySelector('[data-role="pick-staff"]').value).toBe(ana.id);
    expect(container.querySelector('[data-role="pick-period"]').value).toBe("2026-10-01");
    expect(data.listAttendance).toHaveBeenLastCalledWith(expect.any(String), { staffId: ana.id, from: "2026-10-01", to: "2026-10-15" }, { pageSize: 100 });
  });

  it("Attendance & Pay → Payroll: Everyone · the same cutoff; Payroll → back: the same employee and cutoff", async () => {
    const data = fakeData();
    await open(data);
    await pickPeriod("2026-10-01");
    expect(getScope("demo-distributor-a")).toEqual({ staffId: loriza.id, period: { start: "2026-10-01", end: "2026-10-15" } });
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-role="pick-staff"]').value).toBe(""); // Everyone
    expect(container.querySelector('[data-role="period-select"]').value).toBe("2026-10-01_2026-10-15");
    // Tap Loriza: her payslip for that cutoff; close: back on Everyone · Oct 1–15.
    container.querySelector('[data-act="view"]').click();
    await flush();
    expect(document.querySelector('[data-role="payroll-view"] .card-title').textContent).toBe("Loriza Ibanez · Oct 1–15");
    document.querySelector('[data-role="payroll-view"] [data-x="close"]').click();
    await flush();
    expect(container.querySelector('[data-role="period-select"]').value).toBe("2026-10-01_2026-10-15");
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    await open(data);
    expect(container.querySelector('[data-role="pick-staff"]').value).toBe(loriza.id);
    expect(container.querySelector('[data-role="pick-period"]').value).toBe("2026-10-01");
  });

  it("without payroll.view: plain Attendance (no Everyone, no pay)", async () => {
    await open(fakeData(), home("manager", { revoke: ["payroll.view"] }));
    expect(container.querySelector("h1, .page-title").textContent).toBe("Attendance");
    expect([...container.querySelector('[data-role="pick-staff"]').options].map((o) => o.textContent)).not.toContain("Everyone");
    expect(container.querySelector('[data-role="pay-summary"]')).toBeNull();
  });
});

describe("the payslip's actions", () => {
  it("Pay · Payment link · More actions ▾ · Close; Add ▾ and the old More ▾ are gone", async () => {
    const data = fakeData();
    mountPayroll(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    const sel = container.querySelector('[data-role="period-select"]');
    sel.value = "2026-10-01_2026-10-15";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    container.querySelector('[data-act="view"]').click();
    await flush();
    const actions = [...document.querySelectorAll('[data-role="payslip-actions"] > .btn, [data-role="payslip-actions"] > details > summary')].map((b) => b.textContent.trim());
    expect(actions).toEqual(["Pay", "Payment link", "More actions ▾", "Close"]);
    expect(document.querySelector('[data-role="payroll-view"] [data-x="add-bonus"]').closest('[data-role="more-actions"]')).not.toBeNull();
  });
});
