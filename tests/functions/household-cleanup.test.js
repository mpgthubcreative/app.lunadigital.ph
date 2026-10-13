// Owner-pilot cleanup (2026-10-13):
//   1. Payroll eligibility: the Household Staff record alone decides who gets
//      payroll worked out (active, employment dates, a valid pay cycle). A
//      deactivated helper gets no new payroll, not even for the period they
//      left in; their saved payrolls stay as history. ONE rule for the
//      Employee dropdown, the Everyone list and the still-to-pay total.
//   2. Users: Deactivate access (temporary) vs Remove user (the membership
//      of this business goes for good; records, employment and the Luna
//      account itself stay; re-adding links the same staff record).
//   3. Payroll Delete (unpaid) / Void (paid) reverse correctly.
//   4. Paid Leave allowance: household default (5), per-helper number,
//      calendar year, a used-up allowance needs a deliberate override.

import { describe, it, expect, beforeEach } from "vitest";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createMembersHandler } from "../../netlify/functions/members.js";
import { createMeHandler } from "../../netlify/functions/me.js";
import { createActivateHandler } from "../../netlify/functions/activate.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { payrollEligibility, onPayroll, paidLeaveBalance, paidLeaveAllowance, advanceCapacity } from "../../shared/payroll.js";
import { buildWorld, request } from "../helpers/tenants.js";

const H = "biz-home";
const OTHER = "biz-shop";
const W = 41100;
let world;
let u;
let clock;
const at = (day) => (clock = new Date(`${day}T04:00:00Z`));

beforeEach(async () => {
  at("2026-10-13");
  world = await buildWorld();
  await createBusiness({ ...world, name: "Prado Household", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: H });
  u = {};
  for (const [key, role] of [["carlo", "owner"], ["dad", "manager"]]) {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@home.test`, name: key });
    await addMember({ ...world, businessId: H, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  }
});

const deps = () => ({ getAdmin: async () => world, now: () => clock });
const HANDLERS = { staff: createHouseholdStaffHandler, attendance: createAttendanceHandler, payroll: createPayrollHandler, advances: createAdvancesHandler, members: createMembersHandler };
async function api(kind, uid, body, bid = H) {
  const res = await HANDLERS[kind](deps())({ ...request({ uid, businessId: bid, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function members(uid, bid = H) {
  const res = await createMembersHandler(deps())({ ...request({ uid, businessId: bid, method: "GET" }) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function me(uid) {
  const res = await createMeHandler(deps())({ ...request({ uid, businessId: H, method: "GET" }) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const docAt = (p) => world.db.docs.get(`businesses/${H}/${p}`);
const under = (c) => [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/${H}/${c}/`) && k.split("/").length === 4).map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
const OCT = (d) => `2026-10-${String(d).padStart(2, "0")}`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const staff = async (name, extra = {}) => (await api("staff", u.carlo, { action: "create", staff: { name, dailyWage: W, payCycle: "semi_monthly", startDate: "2026-06-07", ...extra } })).body.staffId;
const mark = (staffId, dates, status = "present", extra = {}) => api("attendance", u.carlo, { action: "setMany", staffId, days: dates.map((date) => ({ date, status })), ...extra });
const view = async (period = null, staffId = null) => (await api("payroll", u.carlo, { action: "period", ...(period ? { period } : {}), ...(staffId ? { staffId } : {}) })).body.view;
async function withLogin(staffId, email = null) {
  const r = await api("staff", u.carlo, { action: "createLogin", staffId, ...(email ? { email } : {}) });
  if (r.body.activationToken) await createActivateHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "activate", token: r.body.activationToken, password: "kape-at-pandesal" }) });
  return r.body.uid;
}

describe("1. payroll eligibility: Household Staff decides, one rule everywhere", () => {
  it("Loriza, Riza and Yanie historically; Riza / Yanie deactivated: dropdown, Everyone list and still-to-pay are Loriza only; paid history stays", async () => {
    const loriza = await staff("Loriza Ibanez");
    const riza = await staff("riza");
    const yanie = await staff("Yanie");
    // Sep 16-30: Yanie worked and was paid (history).
    at("2026-09-30");
    await mark(yanie, range(16, 30).map((d) => `2026-09-${d}`));
    expect((await api("payroll", u.carlo, { action: "release", staffId: yanie, periodStart: "2026-09-16", payment: { method: "cash" } })).status).toBe(200);
    // October: all three have some days recorded, then Riza / Yanie leave.
    at(OCT(12));
    await mark(loriza, range(1, 12).map(OCT));
    await mark(riza, range(3, 10).map(OCT));
    await mark(yanie, range(1, 6).map(OCT));
    expect((await api("staff", u.carlo, { action: "setStatus", staffId: riza, status: "inactive" })).body.endDate).toBe(OCT(12));
    expect((await api("staff", u.carlo, { action: "setStatus", staffId: yanie, status: "inactive" })).body.endDate).toBe(OCT(12));
    at(OCT(13));
    const v = await view();
    expect(v.period).toMatchObject({ start: OCT(1), end: OCT(15) });
    expect(v.rows.map((r) => r.staffName)).toEqual(["Loriza Ibanez"]);
    expect(v.rows[0].netPay).toBe(12 * W); // ₱4,932
    expect(v.rows.filter((r) => r.status !== "released").reduce((t, r) => t + r.netPay, 0)).toBe(493200);
    // The dropdown list: Loriza (current) and Yanie (a saved, paid payroll = history); never Riza.
    expect(v.people.map((p) => p.name)).toEqual(["Loriza Ibanez", "Yanie"]);
    // Yanie's paid Sep 16-30 is still there when that period is viewed.
    const sep = await view({ start: "2026-09-16", end: "2026-09-30" });
    expect(sep.rows.map((r) => [r.staffName, r.status])).toEqual([["Loriza Ibanez", "draft"], ["Yanie", "released"]]);
    // Yanie's own periods: only the saved one.
    expect((await view(null, yanie)).periods.map((p) => p.start)).toEqual(["2026-09-16"]);
    // Nothing deleted: attendance, payroll and staff records all kept.
    expect(docAt(`attendance/${riza}_${OCT(3)}`)).toBeDefined();
    expect(docAt(`attendance/${yanie}_${OCT(1)}`)).toBeDefined();
    expect(docAt(`householdStaff/${riza}`).status).toBe("inactive");
    // No payroll can be worked out or stored for them any more.
    expect((await api("payroll", u.carlo, { action: "prepare", staffId: riza, periodStart: OCT(1) })).body.error).toBe("not-eligible");
    // Opening the page stored nothing.
    expect(under("payrolls").map((p) => p.staffName)).toEqual(["Yanie"]);
  });

  it("paying before deactivating works; reactivating brings the current period back", async () => {
    const riza = await staff("riza");
    at(OCT(12));
    await mark(riza, range(1, 12).map(OCT));
    expect((await api("payroll", u.carlo, { action: "release", staffId: riza, periodStart: OCT(1), payment: { method: "cash" } })).status).toBe(200);
    await api("staff", u.carlo, { action: "setStatus", staffId: riza, status: "inactive" });
    expect((await view()).rows.map((r) => [r.staffName, r.status])).toEqual([["riza", "released"]]); // her paid salary: history
    await api("staff", u.carlo, { action: "setStatus", staffId: riza, status: "active" });
    expect((await view({ start: OCT(16), end: OCT(31) })).periods).toBeDefined();
    expect((await view()).rows.map((r) => r.staffName)).toEqual(["riza"]);
  });

  it("the rule itself (status, dates, pay cycle)", () => {
    const p = { start: OCT(1), end: OCT(15) };
    expect(payrollEligibility({ status: "active", startDate: "2026-10-15" }, p).eligible).toBe(true);
    expect(payrollEligibility({ status: "active", startDate: "2026-10-16" }, p).eligible).toBe(false);
    expect(payrollEligibility({ status: "active", endDate: "2026-09-30" }, p).eligible).toBe(false);
    expect(payrollEligibility({ status: "inactive", endDate: OCT(12) }, p)).toMatchObject({ eligible: false, reason: "Inactive" });
    expect(payrollEligibility(null, p).eligible).toBe(false);
    const s = { status: "active", payCycle: "semi_monthly", startDate: "2026-06-07" };
    expect(onPayroll(s, p)).toBe(true);
    expect(onPayroll(s, { start: OCT(1), end: OCT(31) })).toBe(false); // not one of their periods
    expect(onPayroll({ ...s, payCycle: "fortnightly" }, p)).toBe(false); // invalid pay cycle
    expect(onPayroll({ ...s, status: "inactive" }, p)).toBe(false);
    expect(onPayroll({ ...s, status: "inactive" }, p, { saved: true })).toBe(true); // history
  });
});

describe("2. Users: Deactivate access vs Remove user", () => {
  it("deactivate -> restore -> remove (and from No access); history, staff record and other businesses untouched; re-add links the same staff record", async () => {
    const yanie = await staff("Yanie");
    const uid = await withLogin(yanie, "yanie@gmail.test");
    at(OCT(5));
    await mark(yanie, range(1, 5).map(OCT));
    await api("advances", u.carlo, { action: "give", advance: { staffId: yanie, amount: 50000, date: OCT(5), method: "cash" } });
    // The same person also belongs to another business.
    await createBusiness({ ...world, name: "Corner Shop", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: OTHER });
    await addMember({ ...world, businessId: OTHER, uid, email: "yanie@gmail.test", name: "Yanie", roleTemplate: "manager" });
    // Deactivate (temporary) and restore.
    expect((await api("members", u.carlo, { action: "setAccess", uid, enabled: false })).body.status).toBe("disabled");
    expect((await members(u.carlo)).body.members.find((m) => m.uid === uid).status).toBe("disabled");
    expect((await me(uid)).status).toBe(403);
    expect((await api("members", u.carlo, { action: "setAccess", uid, enabled: true })).body.status).toBe("active");
    expect((await me(uid)).status).toBe(200);
    // Staff can't remove users or themselves.
    expect((await api("members", uid, { action: "remove", uid: u.dad })).status).toBe(403);
    // Remove user.
    const r = await api("members", u.carlo, { action: "remove", uid });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.removed).toBe(true);
    expect((await members(u.carlo)).body.members.map((m) => m.uid)).not.toContain(uid);
    expect((await me(uid)).status).toBe(403);
    expect(world.db.docs.get(`users/${uid}`).businessIds).toEqual([OTHER]);
    expect(world.db.docs.get(`users/${uid}`).defaultBusinessId).toBe(OTHER);
    expect(world.db.docs.get(`businesses/${OTHER}/members/${uid}`).status).toBe("active"); // untouched
    expect(await world.auth.getUser(uid)).toBeDefined(); // the Luna account itself stays
    // Staff record stays (still employed), unlinked; history kept.
    const s = docAt(`householdStaff/${yanie}`);
    expect(s.status).toBe("active");
    expect(s.memberUid ?? null).toBeNull();
    expect(s.login ?? null).toBeNull();
    expect(s.history.at(-1).label).toMatch(/Luna access removed/);
    expect(docAt(`attendance/${yanie}_${OCT(1)}`)).toBeDefined();
    expect(under("advances")).toHaveLength(1);
    expect(under("auditLog").some((a) => a.type === "member.removed" && a.member.uid === uid)).toBe(true);
    // Retrying is harmless.
    expect((await api("members", u.carlo, { action: "remove", uid })).body).toMatchObject({ removed: false, alreadyRemoved: true });
    // Re-add: same staff record, no duplicate.
    const again = await api("staff", u.carlo, { action: "createLogin", staffId: yanie, email: "yanie@gmail.test" });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.uid).toBe(uid);
    expect(docAt(`householdStaff/${yanie}`).memberUid).toBe(uid);
    expect(docAt(`members/${uid}`).staffId).toBe(yanie);
    expect(under("householdStaff")).toHaveLength(1);
    expect((await me(uid)).status).toBe(200);
  });

  it("a No access member can be removed; the account owner and yourself can't; a manager without users.manage can't", async () => {
    const riza = await staff("riza");
    const uid = await withLogin(riza);
    await api("members", u.carlo, { action: "setAccess", uid, enabled: false });
    expect((await api("members", u.carlo, { action: "remove", uid })).body.removed).toBe(true);
    expect((await api("members", u.carlo, { action: "remove", uid: u.carlo })).body.error).toBe("not-yourself");
    expect((await api("members", u.dad, { action: "remove", uid: u.carlo })).status).toBe(403);
  });
});

describe("3. payroll Delete (unpaid) / Void (paid)", () => {
  it("delete an unpaid payroll: manual lines go, attendance / staff / advance stay, the period is automatic again (nothing stored by opening it)", async () => {
    const lor = await staff("Loriza Ibanez");
    at(OCT(12));
    await mark(lor, range(1, 12).map(OCT));
    const adv = (await api("advances", u.carlo, { action: "give", advance: { staffId: lor, amount: 110000, date: OCT(2), method: "cash" } })).body.advanceId;
    const prep = await api("payroll", u.carlo, { action: "prepare", staffId: lor, periodStart: OCT(1) });
    const pid = prep.body.payrollId;
    await api("payroll", u.carlo, { action: "addDeduction", payrollId: pid, deduction: { description: "Broken plate", amount: 10000 } });
    expect((await api("payroll", u.dad, { action: "deleteDraft", payrollId: pid })).status).toBe(200); // manager with payroll.manage
    expect(docAt(`payrolls/${pid}`)).toBeUndefined();
    expect(docAt(`attendance/${lor}_${OCT(1)}`)).toBeDefined();
    expect(docAt(`householdStaff/${lor}`)).toBeDefined();
    expect(docAt(`advances/${adv}`).status).toBe("paid");
    const row = (await view()).rows[0];
    expect(row.automatic).toBe(true);
    expect(row.deductions.map((d) => d.description)).not.toContain("Broken plate");
    expect(row.deductions.find((d) => d.advanceId === adv).amount).toBe(110000); // still owed, still planned
    expect(docAt(`payrolls/${pid}`)).toBeUndefined();
  });

  it("void a paid payroll: the advance deduction is owed again, limit room returns, history kept; staff refused; retry harmless", async () => {
    const lor = await staff("Loriza Ibanez", { advanceLimit: 500000 });
    const uid = await withLogin(lor);
    at(OCT(12));
    await mark(lor, range(1, 12).map(OCT));
    const adv = (await api("advances", u.carlo, { action: "give", advance: { staffId: lor, amount: 50000, date: OCT(2), method: "cash" } })).body.advanceId;
    const paid = await api("payroll", u.carlo, { action: "release", staffId: lor, periodStart: OCT(1), payment: { method: "cash" } });
    const pid = paid.body.payrollId;
    expect(docAt(`advances/${adv}`).deductedAmount).toBe(50000);
    expect(advanceCapacity(docAt(`householdStaff/${lor}`), under("advances")).available).toBe(500000);
    expect((await api("payroll", uid, { action: "void", payrollId: pid, reason: "please" })).status).toBe(403);
    const v = await api("payroll", u.carlo, { action: "void", payrollId: pid, reason: "Entered twice" });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(docAt(`advances/${adv}`).deductedAmount).toBe(0);
    expect(advanceCapacity(docAt(`householdStaff/${lor}`), under("advances")).available).toBe(450000);
    expect(under("voidedPayrolls").map((x) => x.originalId)).toEqual([pid]);
    expect(docAt(`payrolls/${pid}`)).toBeUndefined();
    expect((await api("payroll", u.carlo, { action: "void", payrollId: pid, reason: "Entered twice" })).status).toBeLessThan(500);
    expect(docAt(`advances/${adv}`).deductedAmount).toBe(0);
    expect(under("voidedPayrolls")).toHaveLength(1);
  });
});

describe("4. Paid Leave allowance", () => {
  it("household default 5; 2 used -> 3 remaining; Paid Leave is a paid day, Unpaid Leave isn't and doesn't count", async () => {
    const lor = await staff("Loriza Ibanez");
    at(OCT(12));
    await mark(lor, [OCT(1), OCT(2)], "official_leave");
    await mark(lor, [OCT(3)], "unpaid_leave");
    await mark(lor, range(4, 12).map(OCT));
    const review = (await api("attendance", u.carlo, { action: "review", staffId: lor, periodStart: OCT(1) })).body.review;
    expect(review.leave).toMatchObject({ year: 2026, entitled: 5, used: 2, remaining: 3, source: "household" });
    const row = (await view()).rows[0];
    expect(row.payableDays).toBe(11); // 9 present + 2 paid leave
    expect(row.basePay).toBe(11 * W);
  });

  it("allowance used up: refused unless the Owner overrides with a reason (kept in the history); payroll follows the recorded status", async () => {
    const lor = await staff("Loriza Ibanez", { paidLeaveDays: 2 });
    at(OCT(12));
    await mark(lor, [OCT(1), OCT(2)], "official_leave");
    const no = await mark(lor, [OCT(3)], "official_leave");
    expect(no.body.failed[0]).toMatchObject({ code: "leave-allowance-used" });
    expect(no.body.failed[0].error).toMatch(/Paid Leave allowance has been fully used \(2 of 2 days in 2026\)/);
    expect(docAt(`attendance/${lor}_${OCT(3)}`)).toBeUndefined();
    expect((await mark(lor, [OCT(3)], "official_leave", { leaveOverride: "x" })).body.failed[0].code).toBe("reason-required");
    const ok = await mark(lor, [OCT(3)], "official_leave", { leaveOverride: "Family emergency" });
    expect(ok.body.failed).toEqual([]);
    const line = docAt(`attendance/${lor}_${OCT(3)}`);
    expect(line.leaveOverride).toMatchObject({ reason: "Family emergency", beyondAllowance: 2 });
    expect(line.history.at(-1).label).toMatch(/Paid Leave beyond the allowance \(2 days\) · Reason: Family emergency/);
    expect((await view()).rows[0].payableDays).toBe(3);
    const review = (await api("attendance", u.carlo, { action: "review", staffId: lor, periodStart: OCT(1) })).body.review;
    expect(review.leave).toMatchObject({ entitled: 2, used: 3, remaining: 0, beyond: 1, overrides: 1, source: "staff" });
    // Changing an already-Paid-Leave day's note isn't a new day: no override needed. Unpaid Leave is always fine.
    expect((await mark(lor, [OCT(4)], "unpaid_leave")).body.failed).toEqual([]);
  });

  it("per-helper number beats the household default; the Owner changes the default; helpers can't", async () => {
    const a = await staff("Ana");
    const b = await staff("Bea", { paidLeaveDays: 8 });
    expect((await api("staff", u.carlo, { action: "settings" })).body.settings).toEqual({ paidLeaveDays: 5, leaveYear: "calendar" });
    expect((await api("staff", u.carlo, { action: "saveSettings", settings: { paidLeaveDays: 7 } })).status).toBe(200);
    expect((await api("staff", u.carlo, { action: "saveSettings", settings: { paidLeaveDays: -1 } })).status).toBe(400);
    at(OCT(12));
    const r = async (id) => (await api("attendance", u.carlo, { action: "review", staffId: id, periodStart: OCT(1) })).body.review.leave;
    expect(await r(a)).toMatchObject({ entitled: 7, source: "household" });
    expect(await r(b)).toMatchObject({ entitled: 8, source: "staff" });
    const uid = await withLogin(a);
    expect((await api("staff", uid, { action: "saveSettings", settings: { paidLeaveDays: 30 } })).status).toBe(403);
    expect((await api("staff", uid, { action: "update", staffId: a, changes: { paidLeaveDays: 30 } })).status).toBe(403);
    expect((await api("attendance", uid, { action: "setMany", staffId: a, days: [{ date: OCT(1), status: "official_leave" }], leaveOverride: "mine" })).status).toBe(403);
    // The helper sees their own balance, read-only.
    await mark(a, [OCT(1), OCT(2)], "official_leave");
    expect((await me(uid)).body.me.leave).toEqual({ year: 2026, entitled: 7, used: 2, remaining: 5 });
  });

  it("history stays after the helper's access is deactivated or removed; calendar-year reset", async () => {
    const a = await staff("Ana");
    const uid = await withLogin(a);
    at(OCT(12));
    await mark(a, [OCT(1), OCT(2)], "official_leave");
    await api("members", u.carlo, { action: "setAccess", uid, enabled: false });
    await api("members", u.carlo, { action: "remove", uid });
    const leave = (await api("attendance", u.carlo, { action: "review", staffId: a, periodStart: OCT(1) })).body.review.leave;
    expect(leave).toMatchObject({ used: 2, remaining: 3 });
    // Jan 1: a new allowance year (2026 days don't count in 2027).
    expect((await api("attendance", u.carlo, { action: "review", staffId: a, periodStart: "2027-01-01" })).body.review.leave).toMatchObject({ year: 2027, used: 0, remaining: 5 });
    const lines = [{ date: "2026-12-31", status: "official_leave" }, { date: "2027-01-01", status: "official_leave" }, { date: "2027-01-02", status: "unpaid_leave" }];
    expect(paidLeaveBalance({ staff: {}, lines, year: 2027 })).toMatchObject({ entitled: 5, used: 1, remaining: 4 });
    expect(paidLeaveAllowance({ paidLeaveDays: 0 }, { paidLeaveDays: 5 })).toEqual({ days: 0, source: "staff" });
  });
});
