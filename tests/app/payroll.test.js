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

function fakeData(extra = {}) {
  return {
    activeStaff: vi.fn(async () => [maria]),
    listStaff: vi.fn(async () => ({ rows: [maria], hasMore: false })),
    listAttendance: vi.fn(async (_b, f) => ({ rows: f.staffId ? lines : lines.filter((l) => l.date === f.from), hasMore: false })),
    setAttendance: vi.fn(async () => ({})),
    listPayrolls: vi.fn(async () => ({ rows: [payroll()], hasMore: false })),
    getPayroll: vi.fn(async () => payroll()),
    payrollApi: vi.fn(async (b) => (b.action === "release" ? { receiptToken: "tokTOKtokTOKtokTOKtokTOKtokTOKto" } : { payrollId: "staffMaria0001_2026-10-01" })),
    listAdvances: vi.fn(async () => ({ rows: [{ id: "adv0000000001", staffId: maria.id, staffName: "Maria", date: "2026-10-05", amount: 50000, status: "not_yet_paid", description: "Fare" }], hasMore: false })),
    advancesApi: vi.fn(async () => ({})),
    staffApi: vi.fn(async () => ({ staffId: "x" })),
    ...extra,
  };
}
const payroll = (o = {}) => ({ id: "staffMaria0001_2026-10-01", staffId: maria.id, staffName: "Maria", periodStart: "2026-10-01", periodEnd: "2026-10-15", dailyWage: 60000, present: 10, officialLeave: 2, absent: 3, notMarked: 0, payableDays: 12, basePay: 720000, deductions: [{ id: "adv-x", type: "advance", advanceId: "adv0000000001", description: "Advance 2026-10-05", amount: 50000 }], deductionsTotal: 50000, netPay: 670000, status: "draft", receiptStatus: "none", history: [], ...o });

describe("Attendance", () => {
  it("by employee: Date | Day | Status ▾ | Daily Wage | Payable Amount; totals 12 payable days, ₱7,200", async () => {
    const data = fakeData();
    mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-view="employee"]').click();
    await flush();
    expect(data.listAttendance).toHaveBeenLastCalledWith("demo-distributor-a", { staffId: maria.id, from: "2026-10-16", to: "2026-10-31" }, { pageSize: 100 });
    const form = container.querySelector('[data-role="filters"]');
    form.elements.from.value = "2026-10-01";
    form.elements.to.value = "2026-10-15";
    submit(form);
    await flush();
    const rows = container.querySelectorAll('[data-role="attendance-employee"] tbody tr');
    expect(rows).toHaveLength(15);
    expect(rows[0].textContent).toMatch(/Oct 1, 2026\s*Thu/);
    expect(container.querySelector('[data-role="totals"]').textContent).toMatch(/Present 10 · Official Leave 2 · Absent 3 · Not marked 0 → 12 payable days · ₱7,200\.00 base pay/);
  });

  it("inline status change (Present ▾ -> Absent) goes to the server, then reloads", async () => {
    const data = fakeData();
    mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    const sel = container.querySelector('select[data-act="mark"]');
    sel.value = "absent";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(data.setAttendance).toHaveBeenCalledWith(maria.id, "2026-10-16", "absent");
  });

  it("without attendance.edit the status is read-only", async () => {
    mountAttendance(container, home("manager", { revoke: ["attendance.edit"] }), { data: fakeData(), now: NOW });
    await flush();
    expect(container.querySelector('select[data-act="mark"]').disabled).toBe(true);
  });
});

describe("Payroll", () => {
  it("compact row with counts, base, deductions, net, salary and receipt state", async () => {
    mountPayroll(container, home(), { data: fakeData(), now: NOW, toast: () => {} });
    await flush();
    const row = container.querySelector("tr[data-payroll]");
    expect(row.textContent).toMatch(/Maria/);
    expect(row.textContent).toMatch(/10 \/ 2 \/ 3/);
    expect(row.textContent).toMatch(/₱6,700\.00/);
    expect(row.textContent).toMatch(/Not yet paid/);
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
    await flush();
    const form = lastForm();
    form.elements.method.value = "gcash";
    submit(form);
    await until(() => document.querySelector('[data-role="link-text"]'));
    expect(data.payrollApi).toHaveBeenCalledWith({ action: "release", payrollId: "staffMaria0001_2026-10-01", payment: { method: "gcash", paidDate: "2026-10-16" } });
    expect(document.querySelector('[data-role="link-text"]').value).toBe(receiptUrl("tokTOKtokTOKtokTOKtokTOKtokTOKto"));
    document.querySelector('[data-x="copy"]').click();
    await until(() => copy.mock.calls.length);
    expect(copy).toHaveBeenCalledWith(receiptUrl("tokTOKtokTOKtokTOKtokTOKtokTOKto"));
  });

  it("a household member without payroll.release can't pay; an advance deduction offers 'Deduct next payroll'", async () => {
    mountPayroll(container, home("manager", { revoke: ["payroll.release"] }), { data: fakeData(), now: NOW });
    await flush();
    container.querySelector('[data-act="view"]').click();
    await flush();
    expect(document.querySelector('[data-x="release"]')).toBeNull();
    expect(document.querySelector('[data-x="defer"]')).not.toBeNull();
  });

  it("the 'Paid, awaiting receipt' filter asks for the receipt status", async () => {
    const data = fakeData();
    mountPayroll(container, home(), { data, now: NOW });
    await flush();
    const form = container.querySelector('[data-role="filters"]');
    form.elements.status.value = "awaiting";
    submit(form);
    await flush();
    expect(data.listPayrolls.mock.calls.at(-1)[1]).toEqual({ receiptStatus: "awaiting" });
  });

  it("recent periods follow the cycle", () => {
    expect(recentPeriods("semi_monthly", "2026-10-16", 3).map((p) => p.start)).toEqual(["2026-10-16", "2026-10-01", "2026-09-16"]);
    expect(recentPeriods("weekly", "2026-10-16", 2).map((p) => p.start)).toEqual(["2026-10-12", "2026-10-05"]);
  });
});

describe("Advances", () => {
  it("status is a controlled dropdown; choosing Paid records the release", async () => {
    const data = fakeData();
    mountAdvances(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    const sel = container.querySelector('select[data-act="status"]');
    expect([...sel.options].map((o) => o.textContent)).toEqual(["Not Yet Paid", "Paid"]);
    sel.value = "paid";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const form = lastForm();
    form.elements.reference.value = "GC1";
    submit(form);
    await flush();
    expect(data.advancesApi).toHaveBeenCalledWith({ action: "markPaid", advanceId: "adv0000000001", release: { paidDate: "2026-10-16", method: "cash", reference: "GC1" } });
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
    expect(data.staffApi).toHaveBeenCalledWith({ action: "create", staff: { name: "Lito", position: null, dailyWage: 65050, payCycle: "weekly", phone: null, startDate: null, notes: null } });
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
