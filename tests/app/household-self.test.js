// @vitest-environment jsdom
// Phase 18.6 screens: the household staff screen (their own simple Luna),
// the public activation page, and the Owner's side (create a login, approve
// attendance requests and advance requests).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mountStaffPortal, isStaffPortalSession } from "../../src/staff/portal.js";
import { renderActivatePage } from "../../src/app/activate.js";
import { mount as mountAttendance } from "../../src/modules/attendance/index.js";
import { mount as mountAdvances } from "../../src/modules/advances/index.js";
import { mount as mountStaff } from "../../src/modules/household/index.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { signInEmail } from "../../shared/tenancy.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const NOW = () => new Date("2026-10-16T04:00:00Z");
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const submit = (form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const staffSession = () => {
  const s = sessionFixture({ roleTemplate: "household_staff", workspaceTemplateId: "household-payroll", permissions: resolvePermissions("household_staff") });
  s.member.staffId = "staffMaria0001";
  s.business = { ...s.business, name: "Santos Household" };
  return s;
};
const SHEET = {
  start: "2026-10-01", end: "2026-10-15", current: true, prev: "2026-09-16", next: "2026-10-16", paid: false, canConfirm: true, confirmation: null,
  counts: { present: 11, restDay: 2, absent: 1, officialLeave: 1, unpaidLeave: 0, notMarked: 0, payableDays: 12, basePay: 720000 },
  days: [{ date: "2026-10-01", status: "present", pending: null, lock: null }, { date: "2026-10-02", status: "rest_day", pending: null, lock: null }],
};
const ME = {
  staff: { name: "Maria Santos", dailyWage: 60000, payCycle: "semi_monthly" },
  today: "2026-10-16",
  sheet: SHEET,
  period: { start: "2026-10-16", end: "2026-10-31", days: [], counts: { present: 0, officialLeave: 0 }, estimate: { basicPay: 0, additions: 0, deductions: 50000, netPay: -50000, prepared: false } },
  corrections: [],
  requests: [],
  salaries: [{ id: "staffMaria0001_2026-10-01", period: { start: "2026-10-01", end: "2026-10-15" }, state: "paid", basicPay: 720000, additions: [], deductions: [{ description: "Advance", amount: 50000 }], netPay: 670000, payment: { method: "GCash", paidDate: "2026-10-12", hasProof: true, early: true }, receipt: "not_confirmed" }],
  advances: [{ id: "advA00000001", date: "2026-10-12", releasedOn: "2026-10-12", amount: 200000, status: "paid", remaining: 200000, planned: [{ periodStart: "2026-10-16", periodEnd: "2026-10-31", amount: 200000 }], hasProof: true, received: "awaiting" }],
};

describe("household staff screen", () => {
  it("is used only for a linked staff account without the Owner's tools", () => {
    expect(isStaffPortalSession(staffSession())).toBe(true);
    expect(isStaffPortalSession(sessionFixture({ workspaceTemplateId: "household-payroll" }))).toBe(false);
    const owner = sessionFixture({ workspaceTemplateId: "household-payroll" });
    owner.member.staffId = "staffMaria0001";
    expect(isStaffPortalSession(owner)).toBe(false);
  });

  it("four tabs; Home lists what to confirm (attendance, salary, advance); no Owner tools", async () => {
    const api = vi.fn(async () => ({ me: ME }));
    await mountStaffPortal(container, staffSession(), { api });
    expect(container.querySelector(".staff-hello").textContent).toBe("Hi, Maria!");
    expect([...container.querySelectorAll(".staff-tab")].map((t) => t.textContent)).toEqual(["Home", "Attendance", "Salary", "Advances"]);
    expect([...container.querySelectorAll('[data-role="to-confirm"] li')].map((li) => li.textContent.replace(/\s+/g, " ").trim())).toEqual(["Attendance Oct 1–15Review", "Salary ₱6,700.00 · Oct 1–15Confirm", "Advance ₱2,000.00 · Oct 12Confirm"]);
    // Nothing to operate: no attendance editing, no requests, no advance form.
    expect(container.querySelector('select, [data-act="present"], [data-panel], [data-role="advance-form"]')).toBeNull();
  });

  it("My Attendance: totals for the period, View details, Confirm attendance, Report a correction", async () => {
    const api = vi.fn(async (path, opts) => (opts?.method === "POST" ? { confirmed: true } : { me: ME }));
    await mountStaffPortal(container, staffSession(), { api });
    container.querySelector('[data-act="tab"][data-tab="attendance"]').click();
    const totals = [...container.querySelectorAll('[data-role="totals"] dt')].map((dt) => `${dt.textContent} ${dt.nextElementSibling.textContent}`);
    expect(totals).toEqual(["Present 11 days", "Rest Day 2 days", "Absent 1 day", "Paid Leave 1 day"]);
    container.querySelector('[data-act="details"]').click();
    expect([...container.querySelectorAll('[data-role="days"] li')].map((li) => li.textContent.replace(/\s+/g, " ").trim())).toEqual(["Oct 1Present", "Oct 2Rest Day"]);
    container.querySelector('[data-act="confirm-attendance"]').click();
    await flush();
    expect(api).toHaveBeenCalledWith("me", { method: "POST", body: { action: "confirmAttendance", periodStart: "2026-10-01" } });
    container.querySelector('[data-act="tab"][data-tab="attendance"]').click();
    container.querySelector('[data-act="report"]').click();
    const f = container.querySelector('[data-role="correction-form"]');
    f.elements.date.value = "2026-10-02";
    f.elements.message.value = "I was present on Oct 2";
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(api).toHaveBeenCalledWith("me", { method: "POST", body: { action: "reportCorrection", message: "I was present on Oct 2", date: "2026-10-02" } });
  });

  it("a confirmed period says so; changed since asks to confirm again", async () => {
    const api = vi.fn(async () => ({ me: { ...ME, sheet: { ...SHEET, confirmation: { at: "2026-10-16T02:00:00.000Z", current: true } } } }));
    await mountStaffPortal(container, staffSession(), { api });
    container.querySelector('[data-act="tab"][data-tab="attendance"]').click();
    expect(container.querySelector('[data-role="confirmed"]').textContent).toMatch(/You confirmed this attendance on Oct 16/);
    expect(container.querySelector('[data-act="confirm-attendance"]')).toBeNull();
  });

  it("My Salary: proof of their own salary, I received my salary", async () => {
    const api = vi.fn(async (path, opts) => (opts?.body?.action === "proof" ? { proof: { contentType: "image/png", dataBase64: "iVBORw0KGgo=" } } : opts?.method === "POST" ? {} : { me: ME }));
    await mountStaffPortal(container, staffSession(), { api });
    container.querySelector('[data-act="tab"][data-tab="salary"]').click();
    expect(container.querySelector('[data-salary]').textContent).toMatch(/₱6,700\.00[\s\S]*paid Oct 12 by GCash \(early\)[\s\S]*Please confirm/);
    container.querySelector('[data-act="proof"][data-kind="salary"]').click();
    await flush();
    expect(api).toHaveBeenCalledWith("me", { method: "POST", body: { action: "proof", kind: "salary", recordId: "staffMaria0001_2026-10-01" } });
    expect(document.querySelector('[data-role="proof-viewer"] img')).not.toBeNull();
    document.querySelector('[data-role="proof-viewer"] [data-act="close"]').click();
    container.querySelector('[data-act="received"]').click();
    await flush();
    expect(api).toHaveBeenCalledWith("me", { method: "POST", body: { action: "received", payrollId: "staffMaria0001_2026-10-01" } });
  });

  it("My Advances: amount, date, remaining, planned deduction (read-only), proof, I received this advance", async () => {
    const api = vi.fn(async (path, opts) => (opts?.method === "POST" ? {} : { me: ME }));
    await mountStaffPortal(container, staffSession(), { api });
    container.querySelector('[data-act="tab"][data-tab="advances"]').click();
    const card = container.querySelector('[data-advance="advA00000001"]');
    expect([...card.querySelectorAll("dt")].map((dt) => `${dt.textContent}: ${dt.nextElementSibling.textContent}`)).toEqual(["Amount received: ₱2,000.00", "Date: Oct 12", "Remaining balance: ₱2,000.00", "Planned deduction: ₱2,000.00 Oct 16–31"]);
    expect(card.querySelector("input, select")).toBeNull();
    card.querySelector('[data-act="advance-received"]').click();
    await flush();
    expect(api).toHaveBeenCalledWith("me", { method: "POST", body: { action: "advanceReceived", advanceId: "advA00000001" } });
  });
});

describe("sign in with a login ID; the activation page", () => {
  it("a login ID becomes its reserved-domain email; emails stay as typed (lowercased)", () => {
    expect(signInEmail(" Maria.4821 ")).toBe("maria.4821@staff.luna.invalid");
    expect(signInEmail("Owner@Gmail.com")).toBe("owner@gmail.com");
  });

  it("shows the login, checks the two passwords match, sends the password once, then says how to sign in", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (_u, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      const activation = { businessName: "Santos Household", name: "Maria Santos", login: "maria.4821", usesLoginId: true, used: false, expired: false };
      return { ok: true, json: async () => ({ success: true, activation }) };
    });
    await renderActivatePage(container, { token: "t".repeat(32), fetchImpl });
    expect(container.querySelector('[data-role="login"]').textContent).toBe("maria.4821");
    const form = container.querySelector('[data-role="activate-form"]');
    form.elements.password.value = "kape-at-pandesal";
    form.elements.password2.value = "kape-at-pandesa";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(container.textContent).toMatch(/don't match/);
    expect(calls).toHaveLength(1);
    const form2 = container.querySelector('[data-role="activate-form"]');
    form2.elements.password.value = "kape-at-pandesal";
    form2.elements.password2.value = "kape-at-pandesal";
    form2.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(calls.at(-1)).toEqual({ action: "activate", token: "t".repeat(32), password: "kape-at-pandesal" });
    expect(container.querySelector('[data-role="message"]').textContent).toMatch(/Sign in with maria.4821/);
  });
});

describe("the Owner's side", () => {
  const home = () => sessionFixture({ workspaceTemplateId: "household-payroll" });
  const maria = { id: "staffMaria0001", name: "Maria Santos", dailyWage: 60000, payCycle: "semi_monthly", status: "active" };

  it("older staff requests still show compactly under Needs review, per helper, with Approve all", async () => {
    const reqs = ["2026-10-02", "2026-10-03"].map((d) => ({ id: `staffMaria0001_${d}`, staffId: "staffMaria0001", staffName: "Maria Santos", date: d, status: "present" }));
    const data = {
      activeStaff: vi.fn(async () => [maria]),
      listAttendance: vi.fn(async () => ({ rows: [], hasMore: false })),
      attendanceReview: vi.fn(async () => ({ corrections: [], requests: reqs, confirmation: null })),
      decideAttendanceMany: vi.fn(async (ids) => ({ decided: ids, failed: [] })),
    };
    mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    const box = container.querySelector('[data-section="needs-review"]');
    expect(box.textContent.replace(/\s+/g, " ")).toMatch(/Maria Santos · 2 days sent\s*Present Oct 2, Present Oct 3/);
    box.querySelector('[data-act="approve-all"]').click();
    await flush();
    expect(data.decideAttendanceMany).toHaveBeenCalledWith(reqs.map((r) => r.id), "approve");
  });

  it("?staff=<id>&period=<start> (dashboard / notification) opens that helper and period", async () => {
    const riza = { id: "staffRiza00001", name: "Riza", dailyWage: 50000, payCycle: "semi_monthly", status: "active" };
    const data = { activeStaff: vi.fn(async () => [maria, riza]), listAttendance: vi.fn(async () => ({ rows: [], hasMore: false })), attendanceReview: vi.fn(async () => ({ corrections: [], requests: [], confirmation: null })) };
    window.history.replaceState(null, "", "/attendance?staff=staffRiza00001&period=2026-10-01");
    try {
      mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
      await flush();
      expect(container.querySelector('[data-role="pick-staff"]').value).toBe("staffRiza00001");
      expect(data.listAttendance).toHaveBeenLastCalledWith(expect.any(String), { staffId: "staffRiza00001", from: "2026-10-01", to: "2026-10-15" }, { pageSize: 100 });
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("Advances ?advance=<id> (a notification): the requests are filtered to that person", async () => {
    const reqs = [
      { id: "advMaria00001", staffId: maria.id, staffName: "Maria Santos", date: "2026-10-16", amount: 100000, requestedAmount: 100000, status: "requested" },
      { id: "advRiza000001", staffId: "staffRiza00001", staffName: "Riza", date: "2026-10-16", amount: 50000, requestedAmount: 50000, status: "requested" },
    ];
    const data = { activeStaff: vi.fn(async () => [maria]), listAdvances: vi.fn(async (_b, f) => ({ rows: f.staffId ? reqs.filter((r) => r.staffId === f.staffId) : reqs, hasMore: false })), advancesApi: vi.fn(async () => ({})) };
    window.history.replaceState(null, "", "/advances?advance=advRiza000001");
    try {
      mountAdvances(container, home(), { data, now: NOW, toast: () => {} });
      await flush();
      await flush();
      expect([...container.querySelectorAll('[data-role="advance-requests"] [data-advance]')].map((li) => li.dataset.advance)).toEqual(["advRiza000001"]);
      expect(data.listAdvances.mock.calls.some((c) => c[1].staffId === "staffRiza00001")).toBe(true);
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("Advances: a request is approved with an amount per payroll", async () => {
    const req = { id: "adv0000000002", staffId: maria.id, staffName: "Maria Santos", date: "2026-10-16", amount: 300000, requestedAmount: 300000, status: "requested", description: "School fees" };
    const data = { activeStaff: vi.fn(async () => [maria]), listAdvances: vi.fn(async () => ({ rows: [req], hasMore: false })), advancesApi: vi.fn(async () => ({})) };
    mountAdvances(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-role="advance-requests"]').textContent).toMatch(/Maria Santos asks for ₱3,000.00/);
    container.querySelector('[data-section="requests"] [data-act="approve"]').click();
    await flush();
    const form = lastForm();
    form.elements.amount.value = "2000";
    form.elements.installment.value = "500";
    submit(form);
    await flush();
    expect(data.advancesApi).toHaveBeenCalledWith({ action: "decide", advanceId: req.id, decision: { decision: "approve" }, approval: { amount: 200000, installment: 50000 } });
  });

  it("Household Staff: Create login shows the one-time link to send; no password anywhere", async () => {
    const share = vi.fn(async () => {});
    const data = { listStaff: vi.fn(async () => ({ rows: [maria], hasMore: false })), staffApi: vi.fn(async () => ({ login: "maria.4821", activationToken: "tok".repeat(11) })) };
    mountStaff(container, home(), { data, toast: () => {}, share });
    await flush();
    expect(container.querySelector('[data-col="login"]').textContent).toMatch(/No login/);
    container.querySelector('.menu-item[data-act="login"]').click();
    const form = lastForm();
    expect(form.textContent).not.toMatch(/password/i);
    submit(form);
    await flush();
    expect(data.staffApi).toHaveBeenCalledWith({ action: "createLogin", staffId: maria.id });
    expect(share.mock.calls[0][0]).toMatchObject({ link: expect.stringMatching(/\/activate#(tok){11}$/), rows: [["Their login ID", "maria.4821"]] });
  });
});
