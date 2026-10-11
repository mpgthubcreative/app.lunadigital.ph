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

describe("staff attendance sheet (Owner-pilot polish)", () => {
  const sheetMe = (extra = {}) => ({
    ...ME,
    sheet: {
      start: "2026-10-01", end: "2026-10-15", current: false, prev: "2026-09-16", next: "2026-10-16", paid: false,
      days: [
        { date: "2026-10-01", status: null, pending: null, rejected: null, lock: "More than 14 days ago" },
        { date: "2026-10-02", status: "present", pending: null, rejected: null, lock: "Approved by your employer" },
        { date: "2026-10-03", status: null, pending: "present", rejected: null, lock: null },
        { date: "2026-10-04", status: null, pending: null, rejected: "present", lock: null },
        { date: "2026-10-05", status: null, pending: null, rejected: null, lock: null },
        { date: "2026-10-06", status: null, pending: null, rejected: null, lock: null },
      ],
      ...extra,
    },
  });

  it("one row per date; approved days read-only; select days -> Present; review; one submission", async () => {
    const api = vi.fn(async (path, opts) => (opts?.method === "POST" ? { sent: 2, unchanged: 0 } : { me: sheetMe() }));
    await mountStaffPortal(container, staffSession(), { api });
    const rows = [...container.querySelectorAll('[data-role="sheet"] .sheet-row')];
    expect(rows).toHaveLength(6);
    expect(container.querySelector('[data-role="sheet-period"]').textContent).toMatch(/Oct 1 – Oct 15/);
    // Approved: no dropdown, shown as Approved. Pending: prefilled + Waiting. Rejected: says so.
    expect(rows[1].querySelector("select")).toBeNull();
    expect(rows[1].textContent).toMatch(/Present\s*Approved/);
    expect(rows[2].querySelector("select").value).toBe("present");
    expect(rows[2].textContent).toMatch(/Waiting/);
    expect(rows[3].textContent).toMatch(/Not approved: Present/);
    // Bulk: select Oct 5 and 6, mark Present.
    for (const d of ["2026-10-05", "2026-10-06"]) {
      const box = container.querySelector(`[data-sel="${d}"]`);
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
    container.querySelector('[data-act="bulk"][data-status="present"]').click();
    // And Oct 4 (rejected) as Rest Day from its dropdown.
    const sel = container.querySelector('[data-day-status="2026-10-04"]');
    sel.value = "rest_day";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    container.querySelector('[data-act="sheet-review"]').click();
    expect(container.querySelector('[data-role="review"]').textContent).toMatch(/Oct 4.*Rest Day.*Oct 5.*Present.*Oct 6.*Present/s);
    expect(api).not.toHaveBeenCalledWith("me", expect.objectContaining({ method: "POST" }));
    submit(container.querySelector('[data-role="sheet-form"]'));
    await flush();
    expect(api).toHaveBeenCalledWith("me", { method: "POST", body: { action: "attendanceDays", days: [{ date: "2026-10-04", status: "rest_day" }, { date: "2026-10-05", status: "present" }, { date: "2026-10-06", status: "present" }] } });
    expect(container.querySelector('[data-role="message"]').textContent).toMatch(/Sent 2 days/);
  });

  it("moves between pay periods; future days offer leave / rest day only", async () => {
    const future = sheetMe({ start: "2026-10-16", end: "2026-10-31", current: true, days: [{ date: "2026-10-16", status: null, pending: null, rejected: null, lock: null }, { date: "2026-10-17", status: null, pending: null, rejected: null, lock: null }] });
    const api = vi.fn(async () => ({ me: future }));
    await mountStaffPortal(container, staffSession(), { api });
    expect([...container.querySelector('[data-day-status="2026-10-17"]').options].map((o) => o.value)).toEqual(["", "official_leave", "unpaid_leave", "rest_day"]);
    expect([...container.querySelector('[data-day-status="2026-10-16"]').options].map((o) => o.value)).toContain("present");
    container.querySelector('[data-act="sheet-period"][data-period="2026-09-16"]').click();
    await flush();
    expect(api).toHaveBeenLastCalledWith("me?period=2026-09-16");
  });
});

describe("household staff screen: cash advance limit (Owner-pilot batch)", () => {
  const withLimit = (cap) => ({ ...ME, advanceLimit: cap });
  const open = async (cap, api) => {
    await mountStaffPortal(container, staffSession(), { api });
    container.querySelector('[data-panel="advance"]').click();
    await flush();
  };
  it("shows Limit / Outstanding / Available; above Available is stopped before sending", async () => {
    const api = vi.fn(async (path, opts) => (opts?.method === "POST" ? { advanceId: "x", status: "requested" } : { me: withLimit({ limit: 500000, outstanding: 300000, approved: 0, requested: 0, available: 200000 }) }));
    await open(null, api);
    const box = container.querySelector('[data-role="advance-limit"]').textContent.replace(/\s+/g, " ");
    expect(box).toMatch(/Limit\s*₱5,000\.00\s*Outstanding\s*₱3,000\.00\s*Available\s*₱2,000\.00/);
    const f = container.querySelector('[data-role="advance-form"]');
    f.elements.amount.value = "2500";
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(container.querySelector('[data-panel="advance"] .form-error').textContent).toBe("You can request up to ₱2,000.00 right now.");
    expect(api.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
    const f2 = container.querySelector('[data-role="advance-form"]');
    f2.elements.amount.value = "2000";
    f2.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(api).toHaveBeenCalledWith("me", { method: "POST", body: { action: "advance", amount: 200000 } });
  });
  it("full balance: no form, just how much is left to repay", async () => {
    const api = vi.fn(async () => ({ me: withLimit({ limit: 500000, outstanding: 500000, approved: 0, requested: 0, available: 0 }) }));
    await open(null, api);
    expect(container.querySelector('[data-role="advance-form"]')).toBeNull();
    expect(container.querySelector('[data-role="advance-blocked"]').textContent).toBe("You still have ₱5,000.00 to repay before you can request another advance.");
  });
  it("no limit set: the request form as before, no limit box", async () => {
    const api = vi.fn(async () => ({ me: withLimit({ limit: null, outstanding: 150000, approved: 0, requested: 0, available: null }) }));
    await open(null, api);
    expect(container.querySelector('[data-role="advance-limit"]')).toBeNull();
    expect(container.querySelector('[data-role="advance-form"]')).not.toBeNull();
  });
});

describe("the Owner's side", () => {
  const home = () => sessionFixture({ workspaceTemplateId: "household-payroll" });
  const maria = { id: "staffMaria0001", name: "Maria Santos", dailyWage: 60000, payCycle: "semi_monthly", status: "active" };

  it("Attendance lists staff requests with Approve / Reject; five day types", async () => {
    const data = {
      activeStaff: vi.fn(async () => [maria]),
      listAttendance: vi.fn(async () => ({ rows: [], hasMore: false })),
      pendingAttendanceRequests: vi.fn(async () => [{ id: "staffMaria0001_2026-10-24", staffId: "staffMaria0001", staffName: "Maria Santos", date: "2026-10-24", status: "official_leave", note: "Fiesta", state: "pending" }]),
      decideAttendance: vi.fn(async () => ({})),
    };
    mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-section="requests"] .request-person-head').textContent).toMatch(/Maria Santos\s*1 pending/);
    expect(container.querySelector('[data-section="requests"] .request-group-head').textContent).toMatch(/Oct 16–31 · 1 pending/);
    expect(container.querySelector('[data-role="requests"]').textContent).toMatch(/Paid Leave · Oct 24, 2026/);
    expect([...container.querySelectorAll('[data-staff="staffMaria0001"] .pla-btn')].map((b) => b.textContent)).toEqual(["Present", "Absent", "Leave", "Unpaid", "Rest"]);
    container.querySelector('[data-act="approve"]').click();
    await flush();
    expect(data.decideAttendance).toHaveBeenCalledWith("staffMaria0001_2026-10-24", "approve");
  });

  it("requests are grouped per person and pay period with Approve all", async () => {
    const reqs = ["2026-10-02", "2026-10-03", "2026-10-04"].map((d, i) => ({ id: `staffMaria0001_${d}`, staffId: "staffMaria0001", staffName: "Maria Santos", date: d, status: i === 2 ? "rest_day" : "present", state: "pending" }));
    const data = {
      activeStaff: vi.fn(async () => [maria]),
      listAttendance: vi.fn(async () => ({ rows: [], hasMore: false })),
      pendingAttendanceRequests: vi.fn(async () => reqs),
      decideAttendance: vi.fn(async () => ({})),
      decideAttendanceMany: vi.fn(async (ids) => ({ decided: ids, failed: [] })),
    };
    mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    const head = container.querySelector(".request-group-head").textContent;
    expect(container.querySelector(".request-person-head").textContent).toMatch(/Maria Santos\s*3 pending/);
    expect(head).toMatch(/Oct 1–15 · 3 pending/);
    expect(head).toMatch(/2 Present, 1 Rest Day/);
    container.querySelector('[data-act="approve-all"]').click();
    await flush();
    expect(data.decideAttendanceMany).toHaveBeenCalledWith(reqs.map((r) => r.id), "approve");
  });

  // Owner-pilot batch: the approval list has its own Employee filter.
  const riza = { id: "staffRiza00001", name: "Riza", dailyWage: 50000, payCycle: "semi_monthly", status: "active" };
  const mixed = () => [
    ...["2026-10-02", "2026-10-03"].map((d) => ({ id: `staffMaria0001_${d}`, staffId: "staffMaria0001", staffName: "Maria Santos", date: d, status: "present", state: "pending" })),
    ...["2026-10-05", "2026-10-06", "2026-10-07"].map((d) => ({ id: `staffRiza00001_${d}`, staffId: "staffRiza00001", staffName: "Riza", date: d, status: "official_leave", state: "pending" })),
  ];
  const approvalData = () => ({
    activeStaff: vi.fn(async () => [maria, riza]),
    listAttendance: vi.fn(async () => ({ rows: [], hasMore: false })),
    pendingAttendanceRequests: vi.fn(async () => mixed()),
    decideAttendance: vi.fn(async () => ({})),
    decideAttendanceMany: vi.fn(async (ids) => ({ decided: ids, failed: [] })),
  });

  it("All employees: pending requests grouped by employee; the filter shows one person's only", async () => {
    const data = approvalData();
    mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    const sel = container.querySelector('[data-role="request-staff"]');
    expect([...sel.options].map((o) => o.textContent)).toEqual(["All employees", "Maria Santos (2)", "Riza (3)"]);
    expect([...container.querySelectorAll(".request-person-head")].map((h) => h.textContent.replace(/\s+/g, " ").trim())).toEqual(["Maria Santos 2 pending", "Riza 3 pending"]);
    sel.value = "staffRiza00001";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect([...container.querySelectorAll("[data-request]")].map((li) => li.dataset.request)).toEqual(["staffRiza00001_2026-10-05", "staffRiza00001_2026-10-06", "staffRiza00001_2026-10-07"]);
    // The history below is a separate part with its own purpose.
    expect(container.textContent).toMatch(/Attendance history[\s\S]*Review and correct recorded days/);
  });

  it("bulk approve / reject act on the filtered employee's visible requests only", async () => {
    const data = approvalData();
    mountAttendance(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    const sel = container.querySelector('[data-role="request-staff"]');
    sel.value = "staffMaria0001";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(container.querySelectorAll('[data-act="approve-all"]')).toHaveLength(1);
    container.querySelector('[data-act="approve-all"]').click();
    await flush();
    expect(data.decideAttendanceMany).toHaveBeenCalledWith(["staffMaria0001_2026-10-02", "staffMaria0001_2026-10-03"], "approve");
    sel.value = "staffRiza00001";
    container.querySelector('[data-role="request-staff"]').value = "staffRiza00001";
    container.querySelector('[data-role="request-staff"]').dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    container.querySelector('[data-act="reject-all"]').click();
    await flush();
    expect(data.decideAttendanceMany).toHaveBeenLastCalledWith(["staffRiza00001_2026-10-05", "staffRiza00001_2026-10-06", "staffRiza00001_2026-10-07"], "reject");
    // Never another employee's hidden requests.
    for (const call of data.decideAttendanceMany.mock.calls) expect(new Set(call[0].map((id) => id.split("_")[0])).size).toBe(1);
  });

  it("?staff=<id> (dashboard / notification) opens the approval list filtered to that person", async () => {
    window.history.replaceState(null, "", "/attendance?staff=staffRiza00001");
    try {
      mountAttendance(container, home(), { data: approvalData(), now: NOW, toast: () => {} });
      await flush();
      expect(container.querySelector('[data-role="request-staff"]').value).toBe("staffRiza00001");
      expect([...container.querySelectorAll(".request-person-head")].map((h) => h.textContent.replace(/\s+/g, " ").trim())).toEqual(["Riza 3 pending"]);
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
