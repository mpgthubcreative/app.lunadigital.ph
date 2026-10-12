// Owner-pilot change (2026-10-12): the Owner can delete payrolls and
// advances themselves, safely by state.
//   unpaid payroll   deleted (manual lines go with it; attendance, staff,
//                    advances and their plans stay; the period is worked
//                    out automatically again, nothing re-stored by viewing)
//   paid payroll     voided with a reason: advance deductions back to owed,
//                    days unlocked, receipt link stopped; the record (with
//                    the helper's confirmation and the proof) kept as voided
//   unreleased adv.  deleted
//   released adv.    voided with a reason: owed cancelled, plans leave unpaid
//                    payrolls, repayments reversed (recorded); a deduction
//                    taken by a PAID salary needs that payroll voided first
// Retries are harmless; staff can do none of it.

import { describe, it, expect, beforeEach } from "vitest";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createMeHandler } from "../../netlify/functions/me.js";
import { createActivateHandler } from "../../netlify/functions/activate.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { advanceCapacity } from "../../shared/payroll.js";
import { buildWorld, request } from "../helpers/tenants.js";

const H = "biz-home";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]).toString("base64");
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
const OCT = (n) => `2026-10-${String(n).padStart(2, "0")}`;

async function staff(name, extra = {}) {
  const r = await api("staff", u.mom, { action: "create", staff: { name, dailyWage: 41100, payCycle: "semi_monthly", startDate: "2026-06-07", ...extra } });
  return r.body.staffId;
}
async function withLogin(staffId) {
  const r = await api("staff", u.mom, { action: "createLogin", staffId });
  await createActivateHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "activate", token: r.body.activationToken, password: "kape-at-pandesal" }) });
  return r.body.uid;
}
const mark = (staffId, days) => api("attendance", u.mom, { action: "setMany", staffId, days: days.map((d) => ({ date: d, status: "present" })) });
const give = (staffId, amount, date, proof = null) => api("advances", u.mom, { action: "give", advance: { staffId, amount, date, method: "gcash" }, ...(proof ? { proof } : {}) });
const view = async (staffId) => (await api("payroll", u.mom, { action: "period", period: { start: OCT(1), end: OCT(15) }, staffId })).body.view.rows[0];

describe("unpaid payroll: Delete", () => {
  it("removes the saved payroll and its manual lines; attendance, staff and advance plans stay; the period is automatic again; retry is fine", async () => {
    const y = await staff("Riza");
    await mark(y, [OCT(1), OCT(2), OCT(3)]);
    const a = (await give(y, 30000, OCT(2))).body.advanceId;
    const pid = (await api("payroll", u.mom, { action: "prepare", staffId: y, periodStart: OCT(1) })).body.payrollId;
    await api("payroll", u.mom, { action: "addAddition", payrollId: pid, addition: { type: "bonus", amount: 50000 } });
    await api("payroll", u.mom, { action: "addDeduction", payrollId: pid, deduction: { description: "Plate", amount: 1000 } });
    expect(docAt(`attendance/${y}_${OCT(1)}`).payrollId).toBe(pid);
    const r = await api("payroll", u.mom, { action: "deleteDraft", payrollId: pid });
    expect(r.status).toBe(200);
    expect(docAt(`payrolls/${pid}`)).toBeUndefined();
    expect(docAt(`attendance/${y}_${OCT(1)}`)).toMatchObject({ status: "present", payrollId: null });
    expect(docAt(`householdStaff/${y}`)).toBeTruthy();
    expect(docAt(`advances/${a}`).schedule).toMatchObject([{ periodStart: OCT(1), amount: 30000, state: "planned" }]);
    // Automatic again: worked out, manual lines gone, the advance plan still there; nothing stored by viewing.
    const row = await view(y);
    expect(row).toMatchObject({ automatic: true, basePay: 3 * 41100, additionsTotal: 0 });
    expect(row.deductions.map((d) => [d.type, d.amount])).toEqual([["advance", 30000]]);
    expect(docAt(`payrolls/${pid}`)).toBeUndefined();
    expect(under("auditLog").find((x) => x.type === "payroll.deleted")).toMatchObject({ payrollId: pid, staffName: "Riza", manualLines: [{ type: "bonus", amount: 50000 }, { type: "manual", amount: 1000 }] });
    expect((await api("payroll", u.mom, { action: "deleteDraft", payrollId: pid })).body).toMatchObject({ deleted: true, alreadyGone: true });
  });
});

describe("paid payroll: Void (reason, reversals, history kept)", () => {
  it("advance deduction back to owed (limit room too), days unlocked, link stopped, confirmation and proof kept in the voided record", async () => {
    const y = await staff("Yanie", { advanceLimit: 500000 });
    const uid = await withLogin(y);
    await mark(y, [OCT(1), OCT(2), OCT(3)]);
    const a = (await give(y, 50000, OCT(2))).body.advanceId;
    const paid = await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "gcash" }, proof: { contentType: "image/png", dataBase64: PNG } });
    const pid = paid.body.payrollId;
    const p = docAt(`payrolls/${pid}`);
    await me(uid, { action: "received", payrollId: pid });
    expect(docAt(`advances/${a}`).deductedAmount).toBe(50000);
    expect(advanceCapacity(docAt(`householdStaff/${y}`), under("advances")).available).toBe(500000);
    expect((await api("payroll", u.mom, { action: "void", payrollId: pid })).body.error).toBe("reason-required");
    const r = await api("payroll", u.mom, { action: "void", payrollId: pid, reason: "Wrong helper" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.reversals).toEqual([{ type: "advance-deduction", advanceId: a, amount: 50000 }, { type: "attendance-unlocked", days: 3 }]);
    // Gone from the active payroll; the period is unpaid (automatic) again.
    expect(docAt(`payrolls/${pid}`)).toBeUndefined();
    expect(await view(y)).toMatchObject({ automatic: true, status: "draft" });
    // The ₱500 is owed again and planned again; the limit room shrinks back.
    expect(docAt(`advances/${a}`)).toMatchObject({ deductedAmount: 0, deducted: false });
    expect(docAt(`advances/${a}`).schedule).toMatchObject([{ periodStart: OCT(1), amount: 50000, state: "planned" }]);
    expect(advanceCapacity(docAt(`householdStaff/${y}`), under("advances")).available).toBe(450000);
    // Days unlocked; the receipt link no longer works.
    expect((await api("attendance", u.mom, { action: "set", staffId: y, date: OCT(2), status: "absent" })).status).toBe(200);
    expect(world.db.docs.get(`receiptLinks/${p.receiptLinkHash}`)).toBeUndefined();
    // The voided record keeps what was recorded: payment, proof, the helper's confirmation, the reason.
    const v = under("voidedPayrolls")[0];
    expect(v).toMatchObject({ originalId: pid, salary: { amount: p.salary.amount, proof: { path: p.salary.proof.path } }, receiptStatus: "confirmed", void: { reason: "Wrong helper", by: { uid: u.mom }, receiptWas: "confirmed" } });
    // The helper no longer sees it as a salary.
    expect((await me(uid)).body.me.salaries).toEqual([]);
    expect((await api("payroll", u.mom, { action: "voided" })).body.voided).toMatchObject([{ staffName: "Yanie", reason: "Wrong helper", amountPaid: p.salary.amount }]);
    // Retry is harmless.
    expect((await api("payroll", u.mom, { action: "void", payrollId: pid, reason: "Wrong helper" })).body).toMatchObject({ voided: true, alreadyVoided: true });
    expect(under("auditLog").find((x) => x.type === "payroll.voided")).toMatchObject({ payrollId: pid, reason: "Wrong helper", amountPaid: p.salary.amount });
  });

  it("void is only for a paid payroll; an unpaid one is deleted instead", async () => {
    const y = await staff("Riza");
    await mark(y, [OCT(1)]);
    const pid = (await api("payroll", u.mom, { action: "prepare", staffId: y, periodStart: OCT(1) })).body.payrollId;
    expect((await api("payroll", u.mom, { action: "void", payrollId: pid, reason: "Mistake" })).body.error).toBe("payroll-unpaid");
  });
});

describe("advances: Delete (never given) / Void (given)", () => {
  it("an advance never given is deleted outright (approved or requested); retry is fine", async () => {
    const y = await staff("Riza");
    const a = (await api("advances", u.mom, { action: "create", advance: { staffId: y, date: OCT(2), amount: 200000 } })).body.advanceId;
    expect((await api("advances", u.mom, { action: "delete", advanceId: a })).status).toBe(200);
    expect(docAt(`advances/${a}`)).toBeUndefined();
    expect((await api("advances", u.mom, { action: "delete", advanceId: a })).body).toMatchObject({ deleted: true, alreadyGone: true });
    const uid = await withLogin(y);
    const req = (await me(uid, { action: "advance", amount: 10000 })).body.advanceId;
    expect((await api("advances", u.mom, { action: "delete", advanceId: req })).status).toBe(200);
  });

  it("a given advance with no repayment: void with a reason; owed cancelled, its planned deduction leaves the unpaid payroll; limit room back", async () => {
    const y = await staff("Yanie", { advanceLimit: 500000 });
    await mark(y, [OCT(1)]);
    const a = (await give(y, 200000, OCT(2), { contentType: "image/png", dataBase64: PNG })).body.advanceId;
    const pid = (await api("payroll", u.mom, { action: "prepare", staffId: y, periodStart: OCT(1) })).body.payrollId;
    expect(docAt(`payrolls/${pid}`).deductionsTotal).toBe(200000);
    expect((await api("advances", u.mom, { action: "delete", advanceId: a })).body.error).toBe("advance-paid");
    expect((await api("advances", u.mom, { action: "void", advanceId: a })).body.error).toBe("reason-required");
    const r = await api("advances", u.mom, { action: "void", advanceId: a, reason: "Entered twice" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(docAt(`advances/${a}`)).toBeUndefined();
    expect(docAt(`payrolls/${pid}`)).toMatchObject({ deductionsTotal: 0, netPay: 41100 });
    expect(advanceCapacity(docAt(`householdStaff/${y}`), under("advances")).available).toBe(500000);
    expect(under("voidedAdvances")[0]).toMatchObject({ originalId: a, amount: 200000, proof: { contentType: "image/png" }, void: { reason: "Entered twice", reversals: [{ type: "balance-cancelled", amount: 200000 }, { type: "planned-deductions-removed", amount: 200000 }] } });
    expect((await api("advances", u.mom, { action: "void", advanceId: a, reason: "Entered twice" })).body).toMatchObject({ voided: true, alreadyVoided: true });
    expect((await api("advances", u.mom, { action: "voided" })).body.voided).toMatchObject([{ staffName: "Yanie", amount: 200000, reason: "Entered twice" }]);
  });

  it("with repayment activity: separate repayments are reversed (recorded); a deduction taken by a PAID salary needs that payroll voided first", async () => {
    const y = await staff("Yanie", { advanceLimit: 500000 });
    const uid = await withLogin(y);
    await mark(y, [OCT(1), OCT(2), OCT(3)]);
    const a = (await give(y, 100000, OCT(2))).body.advanceId;
    await api("advances", u.mom, { action: "schedule", advanceId: a, schedule: [{ periodStart: OCT(1), amount: 40000 }, { periodStart: OCT(16), amount: 40000 }] });
    await api("advances", u.mom, { action: "repay", advanceId: a, repayment: { amount: 20000, method: "cash" } });
    await me(uid, { action: "advanceReceived", advanceId: a });
    const pid = (await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "cash" } })).body.payrollId;
    const salary = docAt(`payrolls/${pid}`).salary.amount;
    // A paid salary took 400: voiding the advance first is refused, and names the payroll.
    const blocked = await api("advances", u.mom, { action: "void", advanceId: a, reason: "Wrong employee" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/Paid salary already took ₱400\.00 \(2026-10-01 to 2026-10-15\).*Void that payroll first/);
    expect(docAt(`payrolls/${pid}`).salary.amount).toBe(salary); // the paid salary isn't touched
    // Void the payroll, then the advance: the repayment is reversed and recorded.
    expect((await api("payroll", u.mom, { action: "void", payrollId: pid, reason: "Wrong employee" })).status).toBe(200);
    const r = await api("advances", u.mom, { action: "void", advanceId: a, reason: "Wrong employee" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.reversals).toEqual([{ type: "balance-cancelled", amount: 80000 }, { type: "repayments-reversed", amount: 20000, count: 1 }, { type: "planned-deductions-removed", amount: 80000 }]);
    expect(under("voidedAdvances")[0]).toMatchObject({ repayments: [{ amount: 20000 }], void: { receiptWas: "confirmed" } });
    expect(advanceCapacity(docAt(`householdStaff/${y}`), under("advances")).available).toBe(500000);
    expect((await me(uid)).body.me.advances).toEqual([]);
  });
});

describe("the helper can't delete or void anything (server-side)", () => {
  it("403 for every delete / void / list", async () => {
    const y = await staff("Yanie");
    const uid = await withLogin(y);
    await mark(y, [OCT(1)]);
    const a = (await give(y, 10000, OCT(2))).body.advanceId;
    const pid = (await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "cash" } })).body.payrollId;
    const r = [
      await api("payroll", uid, { action: "deleteDraft", payrollId: pid }),
      await api("payroll", uid, { action: "void", payrollId: pid, reason: "mine" }),
      await api("payroll", uid, { action: "voided" }),
      await api("advances", uid, { action: "delete", advanceId: a }),
      await api("advances", uid, { action: "void", advanceId: a, reason: "mine" }),
      await api("advances", uid, { action: "voided" }),
    ];
    expect(r.map((x) => x.status)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(docAt(`payrolls/${pid}`)).toBeTruthy();
    expect(docAt(`advances/${a}`)).toBeTruthy();
  });
});
