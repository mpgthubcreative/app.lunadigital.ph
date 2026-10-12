// Owner-pilot refinement (2026-10-12): early salary, prepaid days, salary
// overpayment carried over, confirmations.
//   Attendance records reality (upcoming days can't be marked). A salary
//   payment records money actually given (earned so far + prepaid upcoming
//   days), never rewritten. After the period: final salary vs paid gives a
//   salary overpayment (carried to the next unpaid payroll as its own line;
//   lowered only by a paid payroll, a repayment or a waiver; never a cash
//   advance, never against the advance limit) or additional salary due.

import { describe, it, expect, beforeEach } from "vitest";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createMeHandler } from "../../netlify/functions/me.js";
import { createActivateHandler } from "../../netlify/functions/activate.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { advanceCapacity, reconcileOf } from "../../shared/payroll.js";
import { buildWorld, request } from "../helpers/tenants.js";

const H = "biz-home";
const W = 41100; // ₱411 a day
let world;
let u;
let clock;
const at = (day) => (clock = new Date(`${day}T04:00:00Z`));

beforeEach(async () => {
  at("2026-10-12");
  world = await buildWorld();
  await createBusiness({ ...world, name: "Santos Household", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: H });
  u = {};
  for (const [key, role] of [["mom", "owner"], ["dad", "manager"]]) {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@home.test`, name: key });
    await addMember({ ...world, businessId: H, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  }
});

const deps = () => ({ getAdmin: async () => world, now: () => clock });
const HANDLERS = { staff: createHouseholdStaffHandler, attendance: createAttendanceHandler, payroll: createPayrollHandler, advances: createAdvancesHandler };
async function api(kind, uid, body) {
  const res = await HANDLERS[kind](deps())({ ...request({ uid, businessId: H, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function me(uid, body = null) {
  const res = await createMeHandler(deps())({ ...request({ uid, businessId: H, method: body ? "POST" : "GET" }), ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const docAt = (p) => world.db.docs.get(`businesses/${H}/${p}`);
const under = (c) => [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/${H}/${c}/`) && k.split("/").length === 4).map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
const D = (m, d) => `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const OCT = (d) => D(10, d);
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

async function staff(name, extra = {}) {
  return (await api("staff", u.mom, { action: "create", staff: { name, dailyWage: W, payCycle: "semi_monthly", startDate: "2026-06-07", ...extra } })).body.staffId;
}
async function withLogin(staffId) {
  const r = await api("staff", u.mom, { action: "createLogin", staffId });
  await createActivateHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "activate", token: r.body.activationToken, password: "kape-at-pandesal" }) });
  return r.body.uid;
}
const mark = (staffId, dates, status = "present") => api("attendance", u.mom, { action: "setMany", staffId, days: dates.map((date) => ({ date, status })) });
const row = async (staffId, start, end) => (await api("payroll", u.mom, { action: "period", period: { start, end }, staffId })).body.view.rows[0];
// Oct 1-12 present; on Oct 12 the Owner pays the whole Oct 1-15 (3 days prepaid).
async function paidEarly(staffId, prepaidDays = 3) {
  at(OCT(12));
  await mark(staffId, range(1, 12).map(OCT));
  const r = await api("payroll", u.mom, { action: "release", staffId, periodStart: OCT(1), payment: { method: "gcash", ...(prepaidDays ? { prepaidDays } : {}) } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.payrollId;
}

describe("the exact scenario: paid the full Oct 1-15 on Oct 12", () => {
  it("upcoming days stay unmarked; paid = earned + prepaid; one day absent -> salary overpayment carried to Oct 16-31; separate from a cash advance", async () => {
    const y = await staff("Yanie", { advanceLimit: 500000 });
    const uid = await withLogin(y);
    at(OCT(12));
    // 3-4. Attendance through Oct 12 only; Oct 13-15 can't be marked yet (not even leave).
    await mark(y, range(1, 12).map(OCT));
    const up = await mark(y, [OCT(13), OCT(14)]);
    expect(up.body.failed.map((f) => [f.date, f.code])).toEqual([[OCT(13), "invalid-date"], [OCT(14), "invalid-date"]]);
    expect((await mark(y, [OCT(15)], "rest_day")).body.failed[0].code).toBe("invalid-date");
    expect(docAt(`attendance/${y}_${OCT(13)}`)).toBeUndefined();
    // 5-6. Paid on Oct 12: earned 12 days + prepaid 3 upcoming days.
    const r = await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "gcash", prepaidDays: 3 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const pid = r.body.payrollId;
    const original = docAt(`payrolls/${pid}`).salary;
    expect(original).toMatchObject({ amount: 15 * W, earned: 12 * W, prepaid: { days: 3, from: OCT(13), to: OCT(15), amount: 3 * W }, paidDate: OCT(12), timing: "early" });
    expect(docAt(`attendance/${y}_${OCT(13)}`)).toBeUndefined(); // no fake attendance
    expect((await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "gcash", prepaidDays: 4 } })).body.error).toBe("payroll-released");
    // 7. The helper confirms the money received (not the upcoming days).
    expect((await me(uid)).body.me.salaries[0].received).toEqual({ earned: 12 * W, prepaid: { days: 3, from: OCT(13), to: OCT(15), amount: 3 * W }, additional: [], total: 15 * W });
    expect((await me(uid, { action: "received", payrollId: pid })).status).toBe(200);
    // A cash advance on Oct 13 stays a cash advance (next unpaid payroll: Oct 16-31).
    at(OCT(13));
    const adv = (await api("advances", u.mom, { action: "give", advance: { staffId: y, amount: 50000, date: OCT(13), method: "cash" } })).body.advanceId;
    expect(docAt(`advances/${adv}`).schedule[0].periodStart).toBe(OCT(16));
    // 8. The days are recorded as they happen: Oct 13, 14 present; Oct 15 absent.
    await mark(y, [OCT(13)]);
    at(OCT(14));
    await mark(y, [OCT(14)]);
    at(OCT(15));
    await mark(y, [OCT(15)], "absent");
    // Still Oct 15: the period isn't over, nothing is settled yet.
    expect(reconcileOf(docAt(`payrolls/${pid}`), OCT(15))).toMatchObject({ ended: false, outstanding: 0 });
    // 10-11. Oct 16: final salary 14 days; ₱411 overpaid, carried to Oct 16-31.
    at(OCT(16));
    const src = await row(y, OCT(1), OCT(15));
    expect(src.reconcile).toMatchObject({ ended: true, paid: 15 * W, final: 14 * W, overpaid: W, outstanding: W, carriedTo: [{ periodStart: OCT(16), periodEnd: OCT(31), amount: W }] });
    const next = await row(y, OCT(16), D(10, 31));
    // 14. Two separate sources on the next payroll.
    expect(next.deductions.map((d) => [d.type, d.amount, d.sourcePayrollId ?? d.advanceId])).toEqual([["advance", 50000, adv], ["overpayment", W, pid]]);
    expect(next.deductions.find((d) => d.type === "overpayment").description).toBe("Previous salary overpayment · from 2026-10-01 to 2026-10-15");
    // 15. The advance limit only counts the cash advance.
    expect(advanceCapacity(docAt(`householdStaff/${y}`), under("advances")).available).toBe(450000);
    // 12. Planned isn't repaid: storing the next payroll doesn't lower it.
    await api("payroll", u.mom, { action: "prepare", staffId: y, periodStart: OCT(16) });
    expect(reconcileOf(docAt(`payrolls/${pid}`), OCT(16)).outstanding).toBe(W);
    // The helper sees it in plain words, planned for Oct 16-31.
    expect((await me(uid)).body.me.adjustments).toEqual([{ amount: W, from: { start: OCT(1), end: OCT(15) }, plannedFor: { start: OCT(16), end: D(10, 31) } }]);
    // 13. Paying Oct 16-31 with the deduction settles it.
    at("2026-11-01");
    await mark(y, range(16, 27).map(OCT));
    expect((await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(16), payment: { method: "cash" } })).status).toBe(200);
    const after = docAt(`payrolls/${pid}`);
    expect(reconcileOf(after, "2026-11-01")).toMatchObject({ overpaid: W, applied: W, outstanding: 0 });
    expect(docAt(`payrolls/${y}_${OCT(16)}`).deductions.map((d) => d.type)).toEqual(["advance", "overpayment"]);
    // 16. The original early payment never changed.
    expect(after.salary).toMatchObject({ amount: original.amount, earned: original.earned, prepaid: original.prepaid, paidDate: OCT(12) });
    expect(after.receiptStatus).toBe("confirmed");
  });

  it("9. all three prepaid days earned: difference ₱0, settled, nothing carried", async () => {
    const y = await staff("Yanie");
    const pid = await paidEarly(y);
    at(OCT(13));
    await mark(y, [OCT(13)]);
    at(OCT(15));
    await mark(y, [OCT(14), OCT(15)]);
    at(OCT(16));
    expect((await row(y, OCT(1), OCT(15))).reconcile).toMatchObject({ settled: true, diff: 0, outstanding: 0, additionalDue: 0 });
    expect((await row(y, OCT(16), D(10, 31))).deductions).toEqual([]);
    expect(docAt(`payrolls/${pid}`).salary.amount).toBe(15 * W);
  });
});

describe("the Owner's choices", () => {
  it("additional salary due (earned more than paid early): recorded as an extra payment, never a negative overpayment", async () => {
    const y = await staff("Yanie");
    const pid = await paidEarly(y, 0); // only what was earned through Oct 12
    at(OCT(15));
    await mark(y, [OCT(13), OCT(14), OCT(15)]);
    at(OCT(16));
    const r = (await row(y, OCT(1), OCT(15))).reconcile;
    expect(r).toMatchObject({ additionalDue: 3 * W, overpaid: 0, outstanding: 0 });
    expect((await api("payroll", u.mom, { action: "payAdditional", payrollId: pid, payment: { method: "cash" } })).status).toBe(200);
    const p = docAt(`payrolls/${pid}`);
    expect(p.salary).toMatchObject({ amount: 12 * W, additional: [{ amount: 3 * W, paidDate: OCT(16) }] });
    expect(reconcileOf(p, OCT(16))).toMatchObject({ settled: true });
    expect((await api("payroll", u.mom, { action: "payAdditional", payrollId: pid, payment: { method: "cash" } })).body.error).toBe("nothing-due");
  });

  async function overpaid() {
    const y = await staff("Yanie");
    const pid = await paidEarly(y);
    at(OCT(15));
    await mark(y, [OCT(13), OCT(14)]);
    await mark(y, [OCT(15)], "absent");
    at(OCT(16));
    return { y, pid };
  }

  it("move to another payroll; separate repayment; waive with a reason (history kept)", async () => {
    const { y, pid } = await overpaid();
    expect((await api("payroll", u.mom, { action: "overpayment", payrollId: pid, change: { op: "move", periodStart: D(11, 1) } })).status).toBe(200);
    expect((await row(y, OCT(16), D(10, 31))).deductions).toEqual([]);
    at("2026-11-02");
    expect((await row(y, D(11, 1), D(11, 15))).deductions.map((d) => [d.type, d.amount])).toEqual([["overpayment", W]]);
    expect(reconcileOf(docAt(`payrolls/${pid}`), "2026-11-02").outstanding).toBe(W);
    expect((await api("payroll", u.mom, { action: "overpayment", payrollId: pid, change: { op: "repay", amount: 20000, method: "cash" } })).status).toBe(200);
    expect((await row(y, D(11, 1), D(11, 15))).deductions.map((d) => d.amount)).toEqual([W - 20000]);
    expect((await api("payroll", u.mom, { action: "overpayment", payrollId: pid, change: { op: "waive" } })).body.error).toBe("reason-required");
    expect((await api("payroll", u.mom, { action: "overpayment", payrollId: pid, change: { op: "waive", reason: "Christmas goodwill" } })).status).toBe(200);
    const p = docAt(`payrolls/${pid}`);
    expect(reconcileOf(p, "2026-11-02")).toMatchObject({ repaid: 20000, waived: W - 20000, outstanding: 0 });
    expect(p.overpayment.waivers[0]).toMatchObject({ reason: "Christmas goodwill", by: { uid: u.mom } });
    expect(p.history.at(-1).label).toMatch(/Salary overpayment waived .* Reason: Christmas goodwill/);
    expect((await row(y, D(11, 1), D(11, 15))).deductions).toEqual([]);
    expect((await api("payroll", u.mom, { action: "overpayment", payrollId: pid, change: { op: "keep" } })).body.error).toBe("nothing-owed");
  });

  it("the next payroll was already paid: the overpayment rolls to the next unpaid one", async () => {
    const y = await staff("Yanie");
    const pid = await paidEarly(y);
    at(OCT(15));
    await mark(y, [OCT(13), OCT(14), OCT(15)]); // all earned: settled
    at("2026-11-01");
    await mark(y, range(16, 20).map(OCT));
    expect((await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(16), payment: { method: "cash" } })).status).toBe(200);
    expect(docAt(`payrolls/${y}_${OCT(16)}`).deductions).toEqual([]);
    // Nov 2: the Owner corrects Oct 15 to Absent (after Oct 16-31 was paid).
    at("2026-11-02");
    expect((await api("attendance", u.mom, { action: "set", staffId: y, date: OCT(15), status: "absent" })).status).toBe(200);
    expect((await row(y, OCT(1), OCT(15))).reconcile.carriedTo).toEqual([{ periodStart: D(11, 1), periodEnd: D(11, 15), amount: W }]);
    expect((await row(y, D(11, 1), D(11, 15))).deductions.map((d) => [d.type, d.sourcePayrollId])).toEqual([["overpayment", pid]]);
  });

  it("two separate overpayment sources stay two traceable lines", async () => {
    const { y, pid } = await overpaid();
    // The Owner keeps the first one for Nov 1-15.
    expect((await api("payroll", u.mom, { action: "overpayment", payrollId: pid, change: { op: "move", periodStart: D(11, 1) } })).status).toBe(200);
    // Oct 16-31 also paid early on Oct 29 with 2 prepaid days; Oct 31 absent.
    at(OCT(29));
    await mark(y, range(16, 29).map(OCT));
    const second = (await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(16), payment: { method: "cash", prepaidDays: 2 } })).body;
    expect(second.payrollId).toBeTruthy();
    at(OCT(31));
    await mark(y, [OCT(30)]);
    await mark(y, [OCT(31)], "absent");
    at("2026-11-02");
    const lines = (await row(y, D(11, 1), D(11, 15))).deductions;
    expect(lines.map((d) => [d.type, d.sourcePayrollId, d.amount]).sort()).toEqual([["overpayment", pid, W], ["overpayment", second.payrollId, W]].sort());
  });

  it("the helper can view but not change any of it (server-side)", async () => {
    const { y, pid } = await overpaid();
    const uid = await withLogin(y);
    const r = [
      await api("payroll", uid, { action: "overpayment", payrollId: pid, change: { op: "waive", reason: "please" } }),
      await api("payroll", uid, { action: "overpayment", payrollId: pid, change: { op: "move", periodStart: D(11, 1) } }),
      await api("payroll", uid, { action: "payAdditional", payrollId: pid, payment: { method: "cash" } }),
      await api("payroll", uid, { action: "release", staffId: y, periodStart: OCT(16), payment: { method: "cash" } }),
    ];
    expect(r.map((x) => x.status)).toEqual([403, 403, 403, 403]);
    expect((await me(uid)).body.me.adjustments[0]).toMatchObject({ amount: W });
  });

  it("voiding the payroll that took the overpayment makes it owed again", async () => {
    const { y, pid } = await overpaid();
    at("2026-11-01");
    await mark(y, range(16, 20).map(OCT));
    const p2 = (await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(16), payment: { method: "cash" } })).body.payrollId;
    expect(reconcileOf(docAt(`payrolls/${pid}`), "2026-11-01").outstanding).toBe(0);
    expect((await api("payroll", u.mom, { action: "void", payrollId: pid, reason: "test" })).body.error).toBe("paid-payroll-deduction");
    const v = await api("payroll", u.mom, { action: "void", payrollId: p2, reason: "Wrong amount" });
    expect(v.body.reversals).toContainEqual({ type: "overpayment-deduction", sourcePayrollId: pid, amount: W });
    expect(reconcileOf(docAt(`payrolls/${pid}`), "2026-11-01").outstanding).toBe(W);
  });
});

describe("a day not recorded after the period isn't 'not earned'", () => {
  it("waits (asks to record it) instead of creating an overpayment", async () => {
    const y = await staff("Yanie");
    const pid = await paidEarly(y);
    at(OCT(14));
    await mark(y, [OCT(13), OCT(14)]);
    at(OCT(16)); // Oct 15 forgotten
    expect((await row(y, OCT(1), OCT(15))).reconcile).toMatchObject({ waiting: true, unrecorded: 1, overpaid: 0, outstanding: 0, additionalDue: 0 });
    expect((await row(y, OCT(16), D(10, 31))).deductions).toEqual([]);
    await mark(y, [OCT(15)], "absent");
    expect((await row(y, OCT(1), OCT(15))).reconcile).toMatchObject({ waiting: false, outstanding: W });
    expect(docAt(`payrolls/${pid}`).salary.amount).toBe(15 * W);
  });
});
