// Owner-pilot simplification batch (2026-10-12), Household / Kasambahay:
// the Owner records and manages; the helper reviews and confirms.
//   - advance -> outstanding balance -> repayment plan -> actual repayment
//     (the exact pilot scenario: ₱1,100 split 600 / 500, salary paid early
//     without the 600, a new advance on Oct 13, cash repayment, limits);
//   - payroll lines: Owner lines edit / delete until paid; generated lines
//     protected; a paid salary is corrected with a reason, never erased;
//   - attendance by the Owner (several days), the helper's confirmation and
//     correction reports; proofs served only to their owner;
//   - staff can't do any Owner action (server-side).

import { describe, it, expect, beforeEach } from "vitest";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createMeHandler } from "../../netlify/functions/me.js";
import { createActivateHandler } from "../../netlify/functions/activate.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { householdSummary } from "../../netlify/functions/_lib/household-summary.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { advanceRemaining, advanceCapacity, advanceSummary } from "../../shared/payroll.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { withRequestKey } from "../helpers/request-keys.js";

const H = "biz-home";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]).toString("base64");
const PDF = Buffer.from("%PDF-1.4\n% bank transfer receipt\n").toString("base64");
let world;
let u;
let clock;
const at = (day) => (clock = new Date(`${day}T04:00:00Z`)); // noon in Manila

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
  const res = await HANDLERS[kind](deps())({ ...request({ uid, businessId: H, method: "POST" }), body: JSON.stringify(withRequestKey(kind, body)) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function me(uid, body = null, period = null) {
  const res = await createMeHandler(deps())({ ...request({ uid, businessId: H, method: body ? "POST" : "GET" }), ...(body ? { body: JSON.stringify(body) } : {}), ...(period ? { queryStringParameters: { period } } : {}) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const docAt = (p) => world.db.docs.get(`businesses/${H}/${p}`);
const inbox = (uid) => [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/${H}/members/${uid}/inbox/`)).map(([, v]) => v);
const OCT = (n) => `2026-10-${String(n).padStart(2, "0")}`;

async function staff(name, extra = {}) {
  const r = await api("staff", u.mom, { action: "create", staff: { name, position: "Kasambahay", dailyWage: 41100, payCycle: "semi_monthly", startDate: "2026-06-07", ...extra } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.staffId;
}
async function withLogin(staffId) {
  const r = await api("staff", u.mom, { action: "createLogin", staffId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const res = await createActivateHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "activate", token: r.body.activationToken, password: "kape-at-pandesal" }) });
  expect(res.statusCode).toBe(200);
  return r.body.uid;
}
const give = (staffId, amount, date, extra = {}, proof = null) => api("advances", u.mom, { action: "give", advance: { staffId, amount, date, method: "gcash", ...extra }, ...(proof ? { proof } : {}) });
const plan = (advanceId, schedule) => api("advances", u.mom, { action: "schedule", advanceId, schedule });
const view = async (start, end, staffId) => (await api("payroll", u.mom, { action: "period", period: { start, end }, ...(staffId ? { staffId } : {}) })).body.view;
const markDays = async (staffId, days) => {
  const r = await api("attendance", u.mom, { action: "setMany", staffId, days: days.map((d) => ({ date: d, status: "present" })) });
  expect(r.body.failed, JSON.stringify(r.body)).toEqual([]);
};
const adv = (id) => ({ id, ...docAt(`advances/${id}`) });
const allAdv = (staffId) => [...world.db.docs.entries()].filter(([k, v]) => k.startsWith(`businesses/${H}/advances/`) && v.staffId === staffId).map(([k, v]) => ({ id: k.split("/").pop(), ...v }));

describe("advance repayment plan: the exact pilot scenario", () => {
  it("₱1,100 planned 600 / 500; salary paid early without the 600; moved forward; a new advance on Oct 13; repayments; limits", async () => {
    const y = await staff("Loriza", { advanceLimit: 500000 });
    // 1. The advance (given Oct 2): planned by default for the next unpaid payroll (Oct 1-15).
    const a1 = (await give(y, 110000, OCT(2))).body.advanceId;
    expect(adv(a1).schedule).toMatchObject([{ periodStart: OCT(1), periodEnd: OCT(15), amount: 110000, state: "planned" }]);
    // 2-3. Plan: 600 from Oct 1-15, 500 from Oct 16-31.
    expect((await plan(a1, [{ periodStart: OCT(1), amount: 60000 }, { periodStart: OCT(16), amount: 50000 }])).status).toBe(200);
    expect(adv(a1).schedule.map((e) => [e.periodStart, e.amount, e.state])).toEqual([[OCT(1), 60000, "planned"], [OCT(16), 50000, "planned"]]);
    // 12. A plan isn't a repayment: still ₱1,100 owed; the limit room is unchanged.
    expect(advanceRemaining(adv(a1))).toBe(110000);
    expect(advanceCapacity(docAt(`householdStaff/${y}`), allAdv(y)).available).toBe(390000);
    // A plan can't be more than what's owed.
    expect((await plan(a1, [{ periodStart: OCT(1), amount: 60000 }, { periodStart: OCT(16), amount: 60000 }])).body.error).toBe("over-owed");

    // 4. The Owner pays Oct 1-15 in full, early (Oct 12), WITHOUT the 600: removed from this payroll first.
    await markDays(y, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(OCT));
    let v = await view(OCT(1), OCT(15), y);
    expect(v.rows[0]).toMatchObject({ basePay: 10 * 41100, deductionsTotal: 60000 });
    expect((await plan(a1, [{ periodStart: OCT(1), amount: 60000, state: "not_taken" }, { periodStart: OCT(16), amount: 50000 }])).status).toBe(200);
    v = await view(OCT(1), OCT(15), y);
    expect(v.rows[0]).toMatchObject({ deductionsTotal: 0, netPay: 411000 });
    const paid = await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "gcash" }, expectedNetPay: 411000 });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.paymentTiming).toBe("early");
    const p1 = `${y}_${OCT(1)}`;
    // 5. The original salary stays as paid.
    expect(docAt(`payrolls/${p1}`).salary.amount).toBe(411000);
    // 6. Luna shows the deduction that wasn't taken, still owed.
    v = await view(OCT(1), OCT(15), y);
    expect(v.rows[0].notTaken).toEqual([{ advanceId: a1, amount: 60000, description: "Advance 2026-10-02" }]);
    expect(advanceRemaining(adv(a1))).toBe(110000);
    // Planning into the paid payroll again is refused (the paid salary is never rewritten).
    expect((await plan(a1, [{ periodStart: OCT(1), amount: 60000 }, { periodStart: OCT(16), amount: 50000 }])).body.error).toBe("payroll-released");
    // 7. Move the 600 forward: Oct 16-31 now plans 1,100 for this advance.
    expect((await api("payroll", u.mom, { action: "deferAdvance", payrollId: p1, advanceId: a1 })).status).toBe(200);
    expect(adv(a1).schedule.filter((e) => e.state === "planned").map((e) => [e.periodStart, e.amount])).toEqual([[OCT(16), 110000]]);
    expect(docAt(`payrolls/${p1}`).salary.amount).toBe(411000);
    expect(docAt(`payrolls/${p1}`).netPay).toBe(411000);

    // 8-9. Another advance on Oct 13: the Oct 1-15 salary is paid, so it goes to Oct 16-31.
    at(OCT(13));
    const a2 = (await give(y, 70000, OCT(13))).body.advanceId;
    expect(adv(a2).schedule).toMatchObject([{ periodStart: OCT(16), periodEnd: OCT(31), amount: 70000, state: "planned" }]);
    expect(docAt(`payrolls/${p1}`).deductions).toEqual([]);
    // Limit room: only real balances count (1,100 + 700 owed).
    expect(advanceCapacity(docAt(`householdStaff/${y}`), allAdv(y)).available).toBe(320000);
    expect(advanceSummary(allAdv(y))).toMatchObject({ outstanding: 180000, next: { periodStart: OCT(16), amount: 180000 }, balanceAfterPlanned: 0 });

    // 14. A separate cash repayment of ₱200 on the new advance: owed drops now; the plan trims to fit.
    const rp = await api("advances", u.mom, { action: "repay", advanceId: a2, repayment: { amount: 20000, method: "cash", note: "Gave back cash" } });
    expect(rp.status, JSON.stringify(rp.body)).toBe(200);
    expect(advanceRemaining(adv(a2))).toBe(50000);
    expect(adv(a2).schedule.filter((e) => e.state === "planned").map((e) => e.amount)).toEqual([50000]);
    // 15. Available room grows only by the real repayment.
    expect(advanceCapacity(docAt(`householdStaff/${y}`), allAdv(y)).available).toBe(340000);

    // 10-11. Oct 16-31: one traceable line per advance.
    at("2026-11-01");
    await markDays(y, [16, 17, 19, 20, 21, 22, 23, 24, 26, 27].map(OCT));
    v = await view(OCT(16), OCT(31), y);
    // One line per advance (their order follows the advance ids, which are random).
    expect(v.rows[0].deductions.map((d) => [d.advanceId, d.amount])).toEqual(expect.arrayContaining([[a1, 110000], [a2, 50000]]));
    expect(v.rows[0].deductions).toHaveLength(2);
    // 13. Paying that payroll is the actual repayment.
    expect((await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(16), payment: { method: "cash" } })).status).toBe(200);
    expect(advanceRemaining(adv(a1))).toBe(0);
    expect(advanceRemaining(adv(a2))).toBe(0);
    // (the 600 not taken was moved to Oct 16-31, so the plan's history is one deduction)
    expect(adv(a1).schedule.map((e) => [e.periodStart, e.amount, e.state])).toEqual([[OCT(16), 110000, "applied"]]);
    expect(advanceCapacity(docAt(`householdStaff/${y}`), allAdv(y)).available).toBe(500000);
    // The early Oct 1-15 salary was never rewritten.
    expect(docAt(`payrolls/${p1}`)).toMatchObject({ netPay: 411000, salary: { amount: 411000, paidDate: OCT(12) } });
  });

  it("a deduction planned for a period whose salary is paid without it becomes 'not taken'; Mark repaid separately settles it", async () => {
    const y = await staff("Loriza");
    const a = (await give(y, 60000, OCT(2))).body.advanceId;
    await markDays(y, [OCT(1), OCT(2)]);
    // The Owner takes it off this payroll, pays, then the helper gives the 600 back in cash.
    await plan(a, [{ periodStart: OCT(1), amount: 60000, state: "not_taken" }]);
    expect((await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "cash" } })).status).toBe(200);
    const r = await api("advances", u.mom, { action: "repay", advanceId: a, repayment: { amount: 60000, method: "cash", notTakenPeriod: OCT(1) } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(advanceRemaining(adv(a))).toBe(0);
    expect(adv(a).schedule.map((e) => e.state)).toEqual(["repaid"]);
    expect(adv(a).repayments).toMatchObject([{ amount: 60000, method: "cash", date: OCT(12) }]);
    expect((await view(OCT(1), OCT(15), y)).rows[0].notTaken).toEqual([]);
  });

  it("a payroll paid with the plan in it takes the deduction (applied) and the debt drops", async () => {
    const y = await staff("Loriza");
    const a = (await give(y, 50000, OCT(2))).body.advanceId;
    await markDays(y, [OCT(1), OCT(2), OCT(5)]);
    expect((await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "cash" } })).status).toBe(200);
    expect(docAt(`payrolls/${y}_${OCT(1)}`)).toMatchObject({ deductionsTotal: 50000, netPay: 3 * 41100 - 50000, salary: { amount: 3 * 41100 - 50000 } });
    expect(adv(a).schedule).toMatchObject([{ periodStart: OCT(1), amount: 50000, state: "applied" }]);
    expect(advanceRemaining(adv(a))).toBe(0);
  });
});

describe("payroll lines: the Owner's lines edit / delete until paid; generated lines are protected", () => {
  it("edit a bonus and a manual deduction (history keeps before / after); advance lines and basic pay can't be edited or deleted by hand", async () => {
    const y = await staff("Loriza");
    await markDays(y, [OCT(1), OCT(2)]);
    const a = (await give(y, 10000, OCT(2))).body.advanceId;
    const pid = (await api("payroll", u.mom, { action: "prepare", staffId: y, periodStart: OCT(1) })).body.payrollId;
    const bonus = (await api("payroll", u.mom, { action: "addAddition", payrollId: pid, addition: { type: "bonus", amount: 50000, description: "Fiesta" } })).body.additionId;
    const ded = (await api("payroll", u.mom, { action: "addDeduction", payrollId: pid, deduction: { description: "Broken plate", amount: 10000 } })).body.deductionId;
    expect((await api("payroll", u.mom, { action: "editLine", payrollId: pid, lineId: bonus, changes: { amount: 60000 } })).status).toBe(200);
    expect((await api("payroll", u.mom, { action: "editLine", payrollId: pid, lineId: ded, changes: { amount: 5000, description: "Broken cup" } })).status).toBe(200);
    const p = docAt(`payrolls/${pid}`);
    expect(p).toMatchObject({ additionsTotal: 60000, deductionsTotal: 15000, netPay: 2 * 41100 + 60000 - 15000 });
    expect(p.history.at(-1)).toMatchObject({ label: "Deduction changed ₱100.00 → ₱50.00 (Broken cup)", before: { amount: 10000 }, after: { amount: 5000 } });
    expect((await api("payroll", u.mom, { action: "editLine", payrollId: pid, lineId: `adv-${a}`, changes: { amount: 1 } })).body.error).toBe("generated-line");
    expect((await api("payroll", u.mom, { action: "removeDeduction", payrollId: pid, deductionId: `adv-${a}` })).body.error).toBe("advance-deduction");
    expect((await api("payroll", u.mom, { action: "removeDeduction", payrollId: pid, deductionId: ded })).status).toBe(200);
    expect(docAt(`payrolls/${pid}`).deductionsTotal).toBe(10000);
  });

  it("a paid salary: nothing is deleted; a correction needs a reason and keeps the original (before / after, who, when)", async () => {
    const y = await staff("Loriza");
    await markDays(y, [OCT(1)]);
    const r = await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "cash" } });
    const pid = r.body.payrollId;
    expect((await api("payroll", u.mom, { action: "deleteDraft", payrollId: pid })).body.error).toBe("payroll-released");
    expect((await api("payroll", u.mom, { action: "addDeduction", payrollId: pid, deduction: { description: "x", amount: 100 } })).body.error).toBe("payroll-released");
    expect((await api("payroll", u.mom, { action: "correctPayment", payrollId: pid, correction: { method: "gcash" } })).body.error).toBe("reason-required");
    expect((await api("payroll", u.mom, { action: "correctPayment", payrollId: pid, correction: { method: "gcash", reference: "GC-77" }, reason: "It was GCash, not cash" })).status).toBe(200);
    const p = docAt(`payrolls/${pid}`);
    expect(p.salary).toMatchObject({ method: "gcash", reference: "GC-77", amount: 41100 });
    expect(p.corrections).toMatchObject([{ reason: "It was GCash, not cash", before: { method: "cash", reference: null }, after: { method: "gcash", reference: "GC-77" }, actor: { uid: u.mom } }]);
    expect(p.history.at(-1).label).toMatch(/Payment corrected: method Cash → GCash, reference — → GC-77 · Reason: It was GCash, not cash/);
  });
});

describe("attendance: the Owner records; the helper confirms or reports a correction", () => {
  it("several days for one helper at once; a refused day is named, the rest saved", async () => {
    const y = await staff("Loriza");
    const r = await api("attendance", u.mom, { action: "setMany", staffId: y, days: [{ date: OCT(1), status: "present" }, { date: OCT(2), status: "rest_day" }, { date: OCT(20), status: "present" }] });
    expect(r.status).toBe(200);
    expect(r.body.saved.map((d) => d.date)).toEqual([OCT(1), OCT(2)]);
    expect(r.body.failed).toMatchObject([{ date: OCT(20), code: "invalid-date" }]);
    expect(docAt(`attendance/${y}_${OCT(2)}`)).toMatchObject({ status: "rest_day", source: "owner" });
  });

  it("the helper confirms the period (Owner told by name); a later change shows 'changed since'", async () => {
    const y = await staff("Loriza");
    const uid = await withLogin(y);
    await markDays(y, [OCT(1), OCT(2)]);
    expect((await me(uid, { action: "confirmAttendance", periodStart: OCT(1) })).status).toBe(200);
    expect(inbox(u.mom).find((n) => n.type === "household.attendance_confirmed")).toMatchObject({ title: "Attendance confirmed", message: "Loriza confirmed the attendance for Oct 1–15." });
    expect((await me(uid)).body.me.sheet).toMatchObject({ start: OCT(1), counts: { present: 2 }, confirmation: { current: true } });
    expect((await api("attendance", u.mom, { action: "review", staffId: y, periodStart: OCT(1) })).body.review.confirmation).toMatchObject({ counts: { present: 2 } });
    await api("attendance", u.mom, { action: "set", staffId: y, date: OCT(3), status: "absent" });
    expect((await me(uid)).body.me.sheet.confirmation.current).toBe(false);
    expect((await me(uid, { action: "confirmAttendance", periodStart: "2026-10-16" })).body.error).toBe("invalid-date"); // not started
  });

  it("a correction report: one sentence; the Owner sees it by name, marks it done; the helper sees Done", async () => {
    const y = await staff("Loriza");
    const uid = await withLogin(y);
    const r = await me(uid, { action: "reportCorrection", date: OCT(8), message: "I was present on Oct 8, not absent" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(inbox(u.mom).find((n) => n.type === "household.attendance_correction")).toMatchObject({ title: "Attendance correction", message: 'Loriza reported an attendance correction for Oct 8: "I was present on Oct 8, not absent"', recordId: `${y}_${OCT(8)}` });
    const review = (await api("attendance", u.mom, { action: "review" })).body.review;
    expect(review.corrections).toMatchObject([{ staffId: y, staffName: "Loriza", date: OCT(8), message: "I was present on Oct 8, not absent" }]);
    expect((await api("attendance", u.mom, { action: "resolveCorrection", correctionId: r.body.correctionId, note: "Fixed" })).status).toBe(200);
    expect((await me(uid)).body.me.corrections).toMatchObject([{ state: "resolved", answer: "Fixed" }]);
    expect((await me(uid, { action: "reportCorrection", message: "x" })).status).toBe(400);
  });
});

describe("the helper reviews and confirms: own records and proofs only", () => {
  it("advance given with proof (PNG or PDF); the helper sees it, views their own proof, confirms receiving it", async () => {
    const y = await staff("Loriza");
    const other = await staff("Riza");
    const uid = await withLogin(y);
    const a = (await give(y, 200000, OCT(12), {}, { contentType: "image/png", dataBase64: PNG })).body.advanceId;
    const b = (await give(other, 100000, OCT(12), {}, { contentType: "application/pdf", dataBase64: PDF })).body.advanceId;
    expect(docAt(`advances/${b}`).proof).toMatchObject({ contentType: "application/pdf" });
    expect((await give(other, 1000, OCT(12), {}, { contentType: "application/pdf", dataBase64: Buffer.from("not a pdf").toString("base64") })).status).toBe(400);
    const mine = (await me(uid)).body.me.advances;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: a, amount: 200000, remaining: 200000, hasProof: true, received: "awaiting", planned: [{ periodStart: OCT(1), periodEnd: OCT(15), amount: 200000 }] });
    expect((await me(uid, { action: "proof", kind: "advance", recordId: a })).body.proof.dataBase64).toBe(PNG);
    expect((await me(uid, { action: "proof", kind: "advance", recordId: b })).status).toBe(404);
    expect((await me(uid, { action: "advanceReceived", advanceId: b })).status).toBe(404);
    expect((await me(uid, { action: "advanceReceived", advanceId: a })).status).toBe(200);
    expect(docAt(`advances/${a}`).receipt).toMatchObject({ state: "confirmed" });
    expect(inbox(u.mom).find((n) => n.type === "household.advance_received")).toMatchObject({ message: "Loriza confirmed receiving the ₱2,000.00 advance (Oct 12)." });
    // The Owner's own proof view still works.
    expect((await api("advances", u.dad, { action: "proof", advanceId: b })).body.proof.contentType).toBe("application/pdf");
  });

  it("salary proof: only the helper's own; another helper's is refused", async () => {
    const y = await staff("Loriza");
    const other = await staff("Riza");
    const uid = await withLogin(y);
    await markDays(y, [OCT(1)]);
    await markDays(other, [OCT(1)]);
    await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "gcash" }, proof: { contentType: "image/png", dataBase64: PNG } });
    await api("payroll", u.mom, { action: "release", staffId: other, periodStart: OCT(1), payment: { method: "gcash" }, proof: { contentType: "image/png", dataBase64: PNG } });
    expect((await me(uid, { action: "proof", kind: "salary", recordId: `${y}_${OCT(1)}` })).body.proof.contentType).toBe("image/png");
    expect((await me(uid, { action: "proof", kind: "salary", recordId: `${other}_${OCT(1)}` })).status).toBe(404);
    expect((await me(uid)).body.me.salaries[0]).toMatchObject({ payment: { hasProof: true, early: true }, receipt: "not_confirmed" });
  });

  it("staff can't do Owner actions (server-side): attendance, payroll lines, plans, repayments, advances, limits", async () => {
    const y = await staff("Loriza", { advanceLimit: 500000 });
    const uid = await withLogin(y);
    const a = (await give(y, 10000, OCT(2))).body.advanceId;
    await markDays(y, [OCT(1)]);
    const pid = (await api("payroll", u.mom, { action: "prepare", staffId: y, periodStart: OCT(1) })).body.payrollId;
    const refused = [
      await api("attendance", uid, { action: "setMany", staffId: y, days: [{ date: OCT(2), status: "present" }] }),
      await api("attendance", uid, { action: "set", staffId: y, date: OCT(2), status: "present" }),
      await api("attendance", uid, { action: "resolveCorrection", correctionId: "abcdefgh1234" }),
      await api("payroll", uid, { action: "editLine", payrollId: pid, lineId: `adv-${a}`, changes: { amount: 1 } }),
      await api("payroll", uid, { action: "removeDeduction", payrollId: pid, deductionId: `adv-${a}` }),
      await api("payroll", uid, { action: "correctPayment", payrollId: pid, correction: { method: "gcash" }, reason: "x y z" }),
      await api("payroll", uid, { action: "deferAdvance", payrollId: pid, advanceId: a }),
      await api("advances", uid, { action: "schedule", advanceId: a, schedule: [] }),
      await api("advances", uid, { action: "repay", advanceId: a, repayment: { amount: 10000 } }),
      await api("advances", uid, { action: "give", advance: { staffId: y, amount: 100, date: OCT(2) } }),
      await api("staff", uid, { action: "update", staffId: y, changes: { advanceLimit: 9900000 } }),
    ];
    expect(refused.map((r) => r.status)).toEqual(Array(refused.length).fill(403));
    expect(adv(a).schedule).toHaveLength(1);
  });
});

describe("dashboard: what needs the Owner's attention, per helper", () => {
  it("corrections, salary not confirmed yet, deductions not taken (an advance isn't confirmed since 2026-10-29); helpers with nothing aren't listed", async () => {
    const y = await staff("Yanie");
    const r = await staff("Riza");
    await staff("Lito");
    const yu = await withLogin(y);
    await me(yu, { action: "reportCorrection", date: OCT(8), message: "I was present" });
    await markDays(y, [OCT(1)]);
    await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "cash" } });
    const a = (await give(r, 50000, OCT(2))).body.advanceId;
    await plan(a, [{ periodStart: OCT(1), amount: 50000, state: "not_taken" }]);
    const s = await householdSummary({ db: world.db, tenant: tenantDb(world.db, H), business: { timezone: "Asia/Manila" }, now: clock });
    expect(s.pending.byStaff).toEqual([
      { staffId: y, name: "Yanie", items: { correction: 1, salaryConfirmation: 1 }, total: 2 },
      { staffId: r, name: "Riza", items: { notTaken: 1 }, total: 1 },
    ]);
  });
});
