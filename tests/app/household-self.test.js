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
const ME = {
  staff: { name: "Maria Santos", dailyWage: 60000, payCycle: "semi_monthly" },
  today: "2026-10-16",
  todayStatus: null,
  period: { start: "2026-10-16", end: "2026-10-31", days: [{ date: "2026-10-16", status: null, pending: null }, { date: "2026-10-17", status: null, pending: null }], counts: { present: 0, officialLeave: 0 }, estimate: { basicPay: 0, additions: 0, deductions: 50000, netPay: -50000, prepared: false } },
  requests: [{ id: "r1", date: "2026-10-24", status: "official_leave", statusLabel: "Paid Leave", state: "pending" }],
  salaries: [{ id: "staffMaria0001_2026-10-01", period: { start: "2026-10-01", end: "2026-10-15" }, state: "paid", basicPay: 720000, additions: [], deductions: [{ description: "Advance", amount: 50000 }], netPay: 670000, payment: { method: "GCash", paidDate: "2026-10-15" }, receipt: "not_confirmed" }],
  advances: [{ id: "a1", date: "2026-10-05", amount: 200000, requested: 300000, status: "paid", remaining: 150000, installment: 50000 }],
};

describe("household staff screen", () => {
  it("is used only for a linked staff account without the Owner's tools", () => {
    expect(isStaffPortalSession(staffSession())).toBe(true);
    expect(isStaffPortalSession(sessionFixture({ workspaceTemplateId: "household-payroll" }))).toBe(false);
    const owner = sessionFixture({ workspaceTemplateId: "household-payroll" });
    owner.member.staffId = "staffMaria0001";
    expect(isStaffPortalSession(owner)).toBe(false);
  });

  it("big 'I'm here today'; leave goes for approval; salary breakdown; 'I received my salary'", async () => {
    const api = vi.fn(async (path, opts) => (opts?.method === "POST" ? { state: "pending" } : { me: ME }));
    await mountStaffPortal(container, staffSession(), { api });
    expect(container.querySelector(".staff-hello").textContent).toBe("Hi, Maria!");
    expect(container.querySelector('[data-role="estimate"]').textContent).toBe("-₱500.00");
    container.querySelector('[data-act="present"]').click();
    await flush();
    expect(api).toHaveBeenCalledWith("me", { method: "POST", body: { action: "attendance", date: "2026-10-16", status: "present" } });
    expect(container.querySelector('[data-role="message"]').textContent).toMatch(/approve/);

    container.querySelector('[data-panel="leave"]').click();
    const f = container.querySelector('[data-role="day-form"]');
    f.elements.date.value = "2026-10-24";
    f.querySelector('input[value="rest_day"]').checked = true;
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(api).toHaveBeenCalledWith("me", { method: "POST", body: { action: "attendance", date: "2026-10-24", status: "rest_day" } });

    container.querySelector('[data-act="received"]').click();
    await flush();
    expect(api).toHaveBeenCalledWith("me", { method: "POST", body: { action: "received", payrollId: "staffMaria0001_2026-10-01" } });
    expect(container.querySelector('[data-role="advances"]').textContent).toMatch(/₱1,500.00 left to repay · ₱500.00 each payday/);
    expect(container.querySelector('[data-role="requests"]').textContent).toMatch(/Paid Leave · Oct 24\s*Waiting/);
  });

  it("an advance request sends the amount in centavos", async () => {
    const api = vi.fn(async (path, opts) => (opts?.method === "POST" ? { status: "requested" } : { me: ME }));
    await mountStaffPortal(container, staffSession(), { api });
    container.querySelector('[data-panel="advance"]').click();
    const f = container.querySelector('[data-role="advance-form"]');
    f.elements.amount.value = "1,500";
    f.elements.reason.value = "School fees";
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(api).toHaveBeenCalledWith("me", { method: "POST", body: { action: "advance", amount: 150000, reason: "School fees" } });
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

  it("Attendance lists staff requests with Approve / Reject; five day types", async () => {
    const data = {
      activeStaff: vi.fn(async () => [maria]),
      listAttendance: vi.fn(async () => ({ rows: [], hasMore: false })),
      pendingAttendanceRequests: vi.fn(async () => [{ id: "staffMaria0001_2026-10-24", staffName: "Maria Santos", date: "2026-10-24", status: "official_leave", note: "Fiesta", state: "pending" }]),
      decideAttendance: vi.fn(async () => ({})),
    };
    mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-role="requests"]').textContent).toMatch(/Maria Santos · Paid Leave · Oct 24, 2026/);
    expect([...container.querySelectorAll('[data-staff="staffMaria0001"] .pla-btn')].map((b) => b.textContent)).toEqual(["Present", "Absent", "Leave", "Unpaid", "Rest"]);
    container.querySelector('[data-act="approve"]').click();
    await flush();
    expect(data.decideAttendance).toHaveBeenCalledWith("staffMaria0001_2026-10-24", "approve");
  });

  it("Advances: a request is approved with an amount per payroll", async () => {
    const req = { id: "adv0000000002", staffId: maria.id, staffName: "Maria Santos", date: "2026-10-16", amount: 300000, requestedAmount: 300000, status: "requested", description: "School fees" };
    const data = { activeStaff: vi.fn(async () => [maria]), listAdvances: vi.fn(async () => ({ rows: [req], hasMore: false })), advancesApi: vi.fn(async () => ({})) };
    mountAdvances(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-role="advance-requests"]').textContent).toMatch(/Maria Santos asks for ₱3,000.00/);
    container.querySelector('[data-section="requests"] [data-act="approve"]').click();
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
