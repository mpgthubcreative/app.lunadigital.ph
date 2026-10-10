// Phase 18.6: payroll additions (Bonus, 13th Month Pay), payment proof,
// the Owner's payment status, disputes, and the Household Dashboard summary.

import { describe, it, expect, beforeEach } from "vitest";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createHouseholdSummaryHandler } from "../../netlify/functions/household-summary.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { thirteenthMonthFor } from "../../netlify/functions/_lib/payroll.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { addDays } from "../../shared/metrics.js";

const H = "biz-home";
let world;
let u;
let clock;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]).toString("base64");

beforeEach(async () => {
  world = await buildWorld();
  clock = new Date("2026-12-20T04:00:00Z"); // Dec 20, 12:00 Manila
  await createBusiness({ ...world, name: "Santos Household", planId: "growth", workspaceTemplateId: "household-payroll", businessId: H });
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
const docAt = (p) => world.db.docs.get(`businesses/${H}/${p}`);
async function staff(name = "Maria", payCycle = "monthly") {
  return (await api("staff", u.mom, { action: "create", staff: { name, dailyWage: 60000, payCycle } })).body.staffId;
}
// Monthly payroll with `days` present days, released when `pay`.
async function month(id, ym, days, { pay = true } = {}) {
  for (let i = 0; i < days; i++) await api("attendance", u.mom, { action: "set", staffId: id, date: addDays(`${ym}-01`, i), status: "present" });
  const r = await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: `${ym}-01` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  if (pay) expect((await api("payroll", u.mom, { action: "release", payrollId: r.body.payrollId, payment: { method: "cash" } })).status).toBe(200);
  return r.body.payrollId;
}

describe("Bonus and 13th Month Pay", () => {
  it("Gross = basic + additions; Net = Gross - deductions; a bonus is separate from the 13th month", async () => {
    const id = await staff();
    clock = new Date("2026-11-30T10:00:00Z");
    const p = await month(id, "2026-11", 20, { pay: false }); // ₱12,000 basic
    expect((await api("payroll", u.mom, { action: "addAddition", payrollId: p, addition: { type: "bonus", amount: 100000, description: "Christmas" } })).status).toBe(200);
    expect((await api("payroll", u.mom, { action: "addDeduction", payrollId: p, deduction: { description: "Broken plate", amount: 20000 } })).status).toBe(200);
    expect(docAt(`payrolls/${p}`)).toMatchObject({ basePay: 1200000, additionsTotal: 100000, grossPay: 1300000, deductionsTotal: 20000, netPay: 1280000 });
    // Attendance changes keep the additions in net pay.
    await api("attendance", u.mom, { action: "set", staffId: id, date: "2026-11-21", status: "present" });
    expect(docAt(`payrolls/${p}`)).toMatchObject({ basePay: 1260000, grossPay: 1360000, netPay: 1340000 });
    const bonusId = docAt(`payrolls/${p}`).additions[0].id;
    expect((await api("payroll", u.mom, { action: "removeAddition", payrollId: p, additionId: bonusId })).status).toBe(200);
    expect(docAt(`payrolls/${p}`)).toMatchObject({ additionsTotal: 0, netPay: 1240000 });
  });

  it("13th month = 1/12 of the year's basic pay; prorated by what was earned; never paid twice", async () => {
    const id = await staff();
    // Started in October: Oct ₱12,000 + Nov ₱12,000 paid; December's draft ₱12,000.
    clock = new Date("2026-10-31T10:00:00Z");
    await month(id, "2026-10", 20);
    clock = new Date("2026-11-30T10:00:00Z");
    await month(id, "2026-11", 20);
    clock = new Date("2026-12-31T10:00:00Z");
    const dec = await month(id, "2026-12", 20, { pay: false });
    const sum = (await api("payroll", u.mom, { action: "thirteenth", staffId: id, year: 2026 })).body;
    expect(sum).toMatchObject({ year: 2026, basicPay: 2400000, entitlement: 200000, onPayrolls: 0, remaining: 200000 }); // released only
    // On December's payroll its own basic pay counts too: 36,000 / 12 = 3,000.
    const r = await api("payroll", u.mom, { action: "addAddition", payrollId: dec, addition: { type: "thirteenth" } });
    expect(r.body).toMatchObject({ amount: 300000 });
    expect(docAt(`payrolls/${dec}`).additions[0]).toMatchObject({ type: "thirteenth", year: 2026, amount: 300000, basis: { basicPay: 3600000, entitlement: 300000 } });
    // Nothing left: a second one is refused.
    const again = await api("payroll", u.mom, { action: "addAddition", payrollId: dec, addition: { type: "thirteenth", amount: 100 } });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("thirteenth-over");
    expect((await api("payroll", u.mom, { action: "release", payrollId: dec, payment: { method: "cash" } })).status).toBe(200);
    expect((await api("payroll", u.mom, { action: "thirteenth", staffId: id, year: 2026 })).body).toMatchObject({ entitlement: 300000, paid: 300000, remaining: 0 });
  });

  it("paid in parts (mid-year + December) and re-checked at release if attendance dropped", async () => {
    const id = await staff();
    clock = new Date("2026-06-30T10:00:00Z");
    const jun = await month(id, "2026-06", 24, { pay: false }); // ₱14,400 basic -> ₱1,200
    expect((await api("payroll", u.mom, { action: "addAddition", payrollId: jun, addition: { type: "thirteenth", amount: 120000 } })).status).toBe(200);
    // Days removed after adding it: the 13th month no longer fits; release refuses.
    for (let d = 1; d <= 12; d++) await api("attendance", u.mom, { action: "set", staffId: id, date: `2026-06-${String(d).padStart(2, "0")}`, status: "absent" });
    const refused = await api("payroll", u.mom, { action: "release", payrollId: jun, payment: { method: "cash" } });
    expect(refused.body.error).toBe("thirteenth-over");
    const line = docAt(`payrolls/${jun}`).additions[0].id;
    await api("payroll", u.mom, { action: "removeAddition", payrollId: jun, additionId: line });
    expect((await api("payroll", u.mom, { action: "addAddition", payrollId: jun, addition: { type: "thirteenth" } })).body.amount).toBe(60000);
    expect((await api("payroll", u.mom, { action: "release", payrollId: jun, payment: { method: "cash" } })).status).toBe(200);
    expect(thirteenthMonthFor([{ id: "x", status: "released", periodEnd: "2026-06-30", basePay: 720000, additions: [{ type: "thirteenth", year: 2026, amount: 60000 }] }], 2026)).toMatchObject({ entitlement: 60000, paid: 60000, remaining: 0 });
  });
});

describe("salary payment: proof, the Owner's status, disputes", () => {
  it("GCash with a screenshot: stored, metered, viewable; payment status Paid; employee confirmation still separate", async () => {
    const id = await staff();
    clock = new Date("2026-11-30T10:00:00Z");
    const p = await month(id, "2026-11", 5, { pay: false });
    const r = await api("payroll", u.mom, { action: "release", payrollId: p, payment: { method: "gcash", reference: "GC-9" }, proof: { contentType: "image/png", dataBase64: PNG } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.hasProof).toBe(true);
    const doc = docAt(`payrolls/${p}`);
    expect(doc).toMatchObject({ status: "released", ownerPayment: "paid", receiptStatus: "awaiting", salary: { method: "gcash", proof: { contentType: "image/png" } } });
    expect(doc.salary.proof.path.startsWith(`tenants/${H}/payroll/proofs/`)).toBe(true);
    expect(docAt("usageCurrent/storage").bytes).toBe(208);
    expect((await api("payroll", u.dad, { action: "proof", payrollId: p })).body.proof.dataBase64).toBe(PNG);
    expect((await api("payroll", u.mom, { action: "attachProof", payrollId: p, proof: { contentType: "image/png", dataBase64: PNG } })).body.error).toBe("has-proof");
  });

  it("cash: proof can be added later; a fake image is refused and nothing is stored", async () => {
    const id = await staff();
    clock = new Date("2026-11-30T10:00:00Z");
    const p = await month(id, "2026-11", 5);
    expect((await api("payroll", u.mom, { action: "attachProof", payrollId: p, proof: { contentType: "image/png", dataBase64: Buffer.from("not an image").toString("base64") } })).body.error).toBe("invalid-proof");
    expect(docAt("usageCurrent/storage")?.bytes ?? 0).toBe(0);
    expect((await api("payroll", u.mom, { action: "attachProof", payrollId: p, proof: { contentType: "image/png", dataBase64: PNG } })).status).toBe(200);
    expect(docAt(`payrolls/${p}`).salary.proof).toBeTruthy();
  });

  it("a disputed salary is resolved by the Owner with a note", async () => {
    const id = await staff();
    clock = new Date("2026-11-30T10:00:00Z");
    const p = await month(id, "2026-11", 5);
    await world.db.doc(`businesses/${H}/payrolls/${p}`).set({ ownerPayment: "disputed", dispute: { state: "open", note: "Not received" } }, { merge: true });
    expect((await api("payroll", u.mom, { action: "resolveDispute", payrollId: p, note: "x" })).body.error).toBe("invalid-input");
    expect((await api("payroll", u.mom, { action: "resolveDispute", payrollId: p, note: "Sent again by GCash" })).status).toBe(200);
    expect(docAt(`payrolls/${p}`)).toMatchObject({ ownerPayment: "paid", dispute: { state: "resolved", resolution: "Sent again by GCash" } });
  });
});

describe("Household Dashboard summary", () => {
  it("total to pay at the next cutoff = sum of estimated nets; advance to deduct; last salary's receipt", async () => {
    const maria = await staff("Maria", "semi_monthly");
    const lito = await staff("Lito", "semi_monthly");
    clock = new Date("2026-12-15T10:00:00Z");
    // Maria: Dec 1-15 paid already (receipt awaited); now Dec 16-31 has 3 days so far.
    const paid = await month(maria, "2026-12", 10);
    expect(paid).toBeTruthy();
    clock = new Date("2026-12-18T04:00:00Z");
    for (const d of ["2026-12-16", "2026-12-17", "2026-12-18"]) await api("attendance", u.mom, { action: "set", staffId: maria, date: d, status: "present" });
    // Lito: an advance of ₱1,000 released, ₱400 per payday; 2 days so far.
    const adv = (await api("advances", u.mom, { action: "create", advance: { staffId: lito, date: "2026-12-16", amount: 100000, installment: 40000 } })).body.advanceId;
    await api("advances", u.mom, { action: "markPaid", advanceId: adv, release: { method: "cash" } });
    for (const d of ["2026-12-16", "2026-12-17"]) await api("attendance", u.mom, { action: "set", staffId: lito, date: d, status: "present" });

    const res = await createHouseholdSummaryHandler(deps())({ ...request({ uid: u.dad, businessId: H, method: "GET" }) });
    expect(res.statusCode).toBe(200);
    const s = JSON.parse(res.body).summary;
    const row = (name) => s.staff.find((x) => x.name === name);
    expect(row("Maria")).toMatchObject({ estimatedNet: 180000, advanceToDeduct: 0, payment: "not_paid", period: { start: "2026-12-16", end: "2026-12-31" }, lastSalary: { receipt: "waiting", netPay: 600000 } });
    expect(row("Lito")).toMatchObject({ estimatedNet: 80000, advanceToDeduct: 40000, payment: "not_paid", lastSalary: null });
    expect(s.totalToPay).toBe(260000);
    expect(s.nextCutoff).toBe("2026-12-31");
  });
});
