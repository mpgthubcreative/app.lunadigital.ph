// Phase 14: Household / Kasambahay Payroll on the server: staff, daily
// attendance (Present / Absent / Official Leave), payroll (payable days,
// base pay, advances deducted in full, manual deductions, net pay), salary
// release, the one-time receipt link, notifications, and access.

import { describe, it, expect, beforeEach } from "vitest";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createReceiptHandler, NOT_YOURS_MESSAGE } from "../../netlify/functions/receipt.js";
import { createActivateHandler } from "../../netlify/functions/activate.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { notificationId } from "../../shared/notifications.js";
import { addDays } from "../../shared/metrics.js";
import { createExportsHandler } from "../../netlify/functions/exports.js";
import { readXlsx } from "../../shared/xlsx.js";
import { reportRows } from "../../shared/exports.js";

const NOW = new Date("2026-10-16T04:00:00Z"); // Oct 16, 12:00 Manila
const H = "biz-home";
let world;
let u;
let clock;

beforeEach(async () => {
  world = await buildWorld();
  clock = NOW;
  await createBusiness({ ...world, name: "Santos Household", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: H });
  u = {};
  for (const [key, role] of [["mom", "owner"], ["dad", "manager"], ["helper", "staff"]]) {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@home.test`, name: key });
    await addMember({ ...world, businessId: H, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  }
});

const deps = () => ({ getAdmin: async () => world, now: () => clock });
const HANDLERS = { staff: createHouseholdStaffHandler, attendance: createAttendanceHandler, payroll: createPayrollHandler, advances: createAdvancesHandler };
async function api(kind, uid, body, businessId = H) {
  const res = await HANDLERS[kind](deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
// The receipt link needs the helper signed in (Owner pilot 2026-10-19): uid = who calls (null = signed out).
async function receipt(body, uid = null) {
  const res = await createReceiptHandler(deps())({ ...request({ uid: uid ?? undefined, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const docAt = (p) => world.db.docs.get(`businesses/${H}/${p}`);
const payroll = (id) => docAt(`payrolls/${id}`);

async function maria(extra = {}) {
  const r = await api("staff", u.mom, { action: "create", staff: { name: "Maria", position: "Kasambahay", dailyWage: 60000, payCycle: "semi_monthly", ...extra } });
  expect(r.status).toBe(201);
  return r.body.staffId;
}
const mark = (staffId, date, status, uid = u.mom) => api("attendance", uid, { action: "set", staffId, date, status });
async function markPeriod(staffId, start, statuses) {
  for (let i = 0; i < statuses.length; i++) expect((await mark(staffId, addDays(start, i), statuses[i])).status).toBe(200);
}
// Oct 1-15: 10 Present, 2 Official Leave, 3 Absent
const OCT_1_15 = ["present", "present", "absent", "present", "official_leave", "present", "present", "absent", "present", "present", "official_leave", "present", "absent", "present", "present"];

describe("THE scenario: Maria, ₱600/day, Oct 1-15", () => {
  it("10 Present / 2 Official Leave / 3 Absent -> 12 payable days, ₱7,200 base; ₱500 advance -> ₱6,700 net", async () => {
    const id = await maria();
    await markPeriod(id, "2026-10-01", OCT_1_15);
    const adv = await api("advances", u.mom, { action: "create", advance: { staffId: id, date: "2026-10-05", amount: 50000, description: "Fare home" } });
    expect(docAt(`advances/${adv.body.advanceId}`)).toMatchObject({ status: "not_yet_paid", deductionPayrollId: null });
    await api("advances", u.mom, { action: "markPaid", advanceId: adv.body.advanceId, release: { paidDate: "2026-10-05", method: "cash" } });

    const prep = await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" });
    expect(prep.status).toBe(201);
    const p = payroll(prep.body.payrollId);
    expect(p).toMatchObject({ staffName: "Maria", periodStart: "2026-10-01", periodEnd: "2026-10-15", days: 15, dailyWage: 60000, present: 10, officialLeave: 2, absent: 3, notMarked: 0, payableDays: 12, basePay: 720000, deductionsTotal: 50000, netPay: 670000, status: "draft", receiptStatus: "none" });
    expect(p.deductions).toEqual([{ id: `adv-${adv.body.advanceId}`, type: "advance", advanceId: adv.body.advanceId, description: "Advance 2026-10-05 (Fare home)", amount: 50000 }]);
  });

  it("inline change Absent -> Present recalculates payable days, base and net, and logs previous -> new", async () => {
    const id = await maria();
    await markPeriod(id, "2026-10-01", OCT_1_15);
    const { payrollId } = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).body;
    await mark(id, "2026-10-03", "present", u.dad);
    expect(payroll(payrollId)).toMatchObject({ present: 11, absent: 2, payableDays: 13, basePay: 780000, netPay: 780000 });
    await mark(id, "2026-10-05", "absent", u.dad); // official leave -> absent
    expect(payroll(payrollId)).toMatchObject({ officialLeave: 1, absent: 3, payableDays: 12, basePay: 720000 });
    const line = docAt(`attendance/${id}_2026-10-03`);
    expect(line).toMatchObject({ status: "present", payable: true, payableAmount: 60000, dailyWage: 60000, payrollId });
    expect(line.history.at(-1)).toMatchObject({ label: "Absent → Present", from: "absent", to: "present", actor: { uid: u.dad, name: "dad" } });
  });

  it("days nobody marked aren't payable and show as Not marked; the same status twice is a no-op", async () => {
    const id = await maria();
    await mark(id, "2026-10-02", "present");
    expect((await mark(id, "2026-10-02", "present")).body.unchanged).toBe(true);
    const { payrollId } = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).body;
    expect(payroll(payrollId)).toMatchObject({ present: 1, notMarked: 14, payableDays: 1, basePay: 60000 });
  });
});

describe("pay cycles and periods", () => {
  it("weekly (Mon-Sun) and monthly people get their own periods; a wrong start is refused", async () => {
    const w = await maria({ name: "Lito", payCycle: "weekly" });
    expect((await api("payroll", u.mom, { action: "prepare", staffId: w, periodStart: "2026-10-05" })).status).toBe(201); // a Monday
    expect(payroll(`${w}_2026-10-05`)).toMatchObject({ periodEnd: "2026-10-11", days: 7, payCycle: "weekly" });
    expect((await api("payroll", u.mom, { action: "prepare", staffId: w, periodStart: "2026-10-06" })).body.error).toBe("invalid-period");
    const m = await maria({ name: "Nena", payCycle: "monthly" });
    await api("payroll", u.mom, { action: "prepare", staffId: m, periodStart: "2026-09-01" });
    expect(payroll(`${m}_2026-09-01`)).toMatchObject({ periodEnd: "2026-09-30", days: 30 });
    expect((await api("payroll", u.mom, { action: "prepare", staffId: m, periodStart: "2026-11-01" })).body.error).toBe("invalid-period"); // future
  });

  it("preparing twice returns the same payroll; changing the pay cycle with an unpaid payroll is refused", async () => {
    const id = await maria();
    const a = await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" });
    const b = await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" });
    expect(b.body).toMatchObject({ payrollId: a.body.payrollId, existing: true });
    expect((await api("staff", u.mom, { action: "update", staffId: id, changes: { payCycle: "weekly" } })).body.error).toBe("has-draft-payroll");
    expect((await api("staff", u.mom, { action: "update", staffId: id, changes: { dailyWage: 65000 } })).status).toBe(200);
  });
});

describe("attendance rules", () => {
  it("no future dates, no inactive staff, no dates before the start date, valid statuses only", async () => {
    const id = await maria({ startDate: "2026-10-03" });
    expect((await mark(id, "2026-10-17", "present")).body.error).toBe("invalid-date");
    expect((await mark(id, "2026-10-02", "present")).body.error).toBe("invalid-date");
    expect((await mark(id, "2026-10-04", "holiday")).body.error).toBe("invalid-status");
    // Phase 18.6: Rest Day is a status now (unpaid: no work, no pay).
    expect((await mark(id, "2026-10-04", "rest_day")).status).toBe(200);
    await api("staff", u.mom, { action: "setStatus", staffId: id, status: "inactive" });
    expect((await mark(id, "2026-10-04", "present")).body.error).toBe("inactive-staff");
  });

  it("a paid payroll locks its days", async () => {
    const id = await maria();
    await markPeriod(id, "2026-10-01", OCT_1_15);
    const { payrollId } = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).body;
    await api("payroll", u.mom, { action: "release", payrollId, payment: { method: "cash" } });
    const r = await mark(id, "2026-10-03", "present");
    expect(r).toMatchObject({ status: 409, body: { error: "payroll-released" } });
    // the next period is open
    expect((await mark(id, "2026-10-16", "present")).status).toBe(200);
  });
});

describe("advances: released (Paid / Not Yet Paid) vs deducted", () => {
  it("Not Yet Paid is never deducted; Paid is deducted in full from the NEXT payroll, once", async () => {
    const id = await maria();
    await markPeriod(id, "2026-10-01", OCT_1_15);
    const notPaid = (await api("advances", u.mom, { action: "create", advance: { staffId: id, date: "2026-10-02", amount: 30000 } })).body.advanceId;
    const { payrollId } = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).body;
    expect(payroll(payrollId).deductions).toEqual([]);
    // released on Oct 10 (Oct 1-15 not paid yet): planned for Oct 1-15, so the open draft gets it now
    await api("advances", u.mom, { action: "markPaid", advanceId: notPaid, release: { method: "gcash", reference: "GC123", paidDate: "2026-10-10" } });
    expect(payroll(payrollId)).toMatchObject({ deductionsTotal: 30000, netPay: 720000 - 30000 });
    expect(docAt(`advances/${notPaid}`)).toMatchObject({ status: "paid", method: "gcash", reference: "GC123", paidDate: "2026-10-10" });
    expect(docAt(`advances/${notPaid}`).schedule).toMatchObject([{ periodStart: "2026-10-01", periodEnd: "2026-10-15", amount: 30000, state: "planned" }]);
    await api("payroll", u.mom, { action: "release", payrollId, payment: { method: "cash" } });
    expect(docAt(`advances/${notPaid}`).deducted).toBe(true);
    // the next payroll doesn't deduct it again
    clock = new Date("2026-11-01T04:00:00Z");
    const next = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-16" })).body.payrollId;
    expect(payroll(next).deductions).toEqual([]);
  });

  it("an advance paid with no open payroll is picked up by the next one prepared; 'deduct next payroll' moves it", async () => {
    const id = await maria();
    const a = (await api("advances", u.mom, { action: "create", advance: { staffId: id, date: "2026-10-01", amount: 20000 } })).body.advanceId;
    await api("advances", u.mom, { action: "markPaid", advanceId: a, release: { paidDate: "2026-10-01" } });
    const p1 = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).body.payrollId;
    expect(payroll(p1).deductionsTotal).toBe(20000);
    expect((await api("payroll", u.mom, { action: "deferAdvance", payrollId: p1, advanceId: a })).status).toBe(200);
    expect(payroll(p1).deductions).toEqual([]);
    const p2 = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-16" })).body.payrollId;
    expect(payroll(p2).deductions.map((d) => d.advanceId)).toEqual([a]);
  });

  it("only Not Yet Paid advances can be edited or deleted; status is controlled", async () => {
    const id = await maria();
    const a = (await api("advances", u.mom, { action: "create", advance: { staffId: id, date: "2026-10-01", amount: 20000 } })).body.advanceId;
    expect((await api("advances", u.mom, { action: "update", advanceId: a, changes: { amount: 25000 } })).status).toBe(200);
    expect((await api("advances", u.mom, { action: "update", advanceId: a, changes: { status: "paid" } })).status).toBe(400);
    await api("advances", u.mom, { action: "markPaid", advanceId: a });
    expect((await api("advances", u.mom, { action: "markPaid", advanceId: a })).body.error).toBe("advance-paid");
    expect((await api("advances", u.mom, { action: "delete", advanceId: a })).body.error).toBe("advance-paid");
    expect((await api("advances", u.mom, { action: "create", advance: { staffId: id, date: "2026-10-01", amount: 0 } })).status).toBe(400);
  });

  it("deleting an unpaid payroll gives its advances back to the next payroll", async () => {
    const id = await maria();
    const a = (await api("advances", u.mom, { action: "create", advance: { staffId: id, date: "2026-10-01", amount: 20000 } })).body.advanceId;
    await api("advances", u.mom, { action: "markPaid", advanceId: a, release: { paidDate: "2026-10-01" } });
    const p1 = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).body.payrollId;
    await api("payroll", u.mom, { action: "deleteDraft", payrollId: p1 });
    expect(payroll(p1)).toBeUndefined();
    expect(docAt(`advances/${a}`).deductionPayrollId).toBeNull();
    const again = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).body.payrollId;
    expect(payroll(again).deductionsTotal).toBe(20000);
  });
});

describe("manual deductions", () => {
  it("add and remove while unpaid; advance lines can't be removed by hand", async () => {
    const id = await maria();
    await markPeriod(id, "2026-10-01", OCT_1_15);
    const { payrollId } = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).body;
    const d = await api("payroll", u.mom, { action: "addDeduction", payrollId, deduction: { description: "Broken plate", amount: 10000 } });
    expect(payroll(payrollId)).toMatchObject({ deductionsTotal: 10000, netPay: 710000 });
    expect((await api("payroll", u.mom, { action: "addDeduction", payrollId, deduction: { description: "", amount: 100 } })).status).toBe(400);
    await api("payroll", u.mom, { action: "removeDeduction", payrollId, deductionId: d.body.deductionId });
    expect(payroll(payrollId)).toMatchObject({ deductionsTotal: 0, netPay: 720000 });
  });
});

describe("salary release and the one-time receipt link", () => {
  async function released() {
    const id = await maria();
    await markPeriod(id, "2026-10-01", OCT_1_15);
    const { payrollId } = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).body;
    const r = await api("payroll", u.mom, { action: "release", payrollId, payment: { method: "gcash", reference: "PAY1" } });
    return { id, payrollId, r };
  }

  it("paid != receipt confirmed: release -> Paid, Awaiting confirmation; the token comes back once and only its hash is stored", async () => {
    const { payrollId, r } = await released();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "released", netPay: 720000 });
    expect(r.body.receiptToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const p = payroll(payrollId);
    expect(p).toMatchObject({ status: "released", receiptStatus: "awaiting", salary: { amount: 720000, method: "gcash", reference: "PAY1", paidDate: "2026-10-16" } });
    expect(JSON.stringify([...world.db.docs.values()])).not.toContain(r.body.receiptToken);
    expect(world.db.docs.get(`receiptLinks/${p.receiptLinkHash}`)).toMatchObject({ businessId: H, payrollId, usedAt: null });
  });

  // Maria's own Luna login (activation link; she sets the password).
  async function mariaLogin(staffId, businessId = H, owner = u.mom) {
    const r = await api("staff", owner, { action: "createLogin", staffId }, businessId);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const act = await createActivateHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "activate", token: r.body.activationToken, password: "kape-at-pandesal" }) });
    expect(act.statusCode).toBe(200);
    return r.body.uid;
  }

  it("the helper must sign in; opening shows the SAVED breakdown and records Opened, never Confirmed", async () => {
    const { id, payrollId, r } = await released();
    const helper = await mariaLogin(id);
    expect(await receipt({ action: "view", token: r.body.receiptToken })).toMatchObject({ status: 401 });
    expect(await receipt({ action: "confirm", token: r.body.receiptToken })).toMatchObject({ status: 401 });
    const view = await receipt({ action: "view", token: r.body.receiptToken }, helper);
    expect(view.status).toBe(200);
    expect(view.body.receipt).toMatchObject({ businessName: "Santos Household", employeeName: "Maria", period: { start: "2026-10-01", end: "2026-10-15" }, method: "GCash", paidDate: "2026-10-16", receiptStatus: "awaiting", expired: false, rows: [{ key: "basic", label: "Basic pay", amount: 720000 }], netPay: 720000 });
    const p = payroll(payrollId);
    expect(p.receiptStatus).toBe("awaiting");
    expect(p.receiptOpenedAt).toBeTruthy();
    expect(p.receiptOpenedBy).toEqual({ uid: helper, name: "Maria" });
    expect(p.receiptConfirmation).toBeUndefined();
    // The Owner sees Opened separately from Confirmed.
    const owner = await api("payroll", u.mom, { action: "period", period: { start: "2026-10-01", end: "2026-10-15" }, staffId: id });
    expect(owner.body.view.rows[0].receiptView).toMatchObject({ status: "awaiting", confirmedAt: null, confirmedBy: null });
    expect(owner.body.view.rows[0].receiptView.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("full breakdown: bonus, advance deduction, other deduction, prepaid salary, net pay; no zero rows; a later edit doesn't rewrite it", async () => {
    clock = new Date("2026-10-10T04:00:00Z"); // paid early, on Oct 10
    const id = await maria();
    await markPeriod(id, "2026-10-01", OCT_1_15.slice(0, 10));
    const adv = await api("advances", u.mom, { action: "create", advance: { staffId: id, date: "2026-10-05", amount: 50000, description: "Fare home" } });
    await api("advances", u.mom, { action: "markPaid", advanceId: adv.body.advanceId, release: { paidDate: "2026-10-05", method: "cash" } });
    const { payrollId } = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).body;
    const add = await api("payroll", u.mom, { action: "addAddition", payrollId, addition: { type: "bonus", amount: 100000, description: "Fiesta bonus" } });
    expect(add.status, JSON.stringify(add.body)).toBeLessThan(300);
    const ded = await api("payroll", u.mom, { action: "addDeduction", payrollId, deduction: { description: "Broken glass", amount: 20000 } });
    expect(ded.status, JSON.stringify(ded.body)).toBeLessThan(300);
    const before = payroll(payrollId);
    const r = await api("payroll", u.mom, { action: "release", payrollId, payment: { method: "cash", prepaidDays: 2 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const helper = await mariaLogin(id);
    const view = (await receipt({ action: "view", token: r.body.receiptToken }, helper)).body.receipt;
    const net = before.basePay + 100000 - 50000 - 20000 + 2 * 60000;
    expect(view.rows).toEqual([
      { key: "basic", label: "Basic pay", amount: before.basePay },
      { key: "addition", label: "Fiesta bonus", amount: 100000 },
      { key: "advance", label: "Advance deduction", amount: -50000 },
      { key: "other", label: "Other deductions", note: "Broken glass", amount: -20000 },
      { key: "prepaid", label: "Prepaid salary", note: "2 upcoming days", amount: 120000 },
    ]);
    expect(view.netPay).toBe(net);
    expect(view.rows.reduce((t, x) => t + x.amount, 0)).toBe(net);
    // The stored lines change later (a correction): the receipt still shows what was paid.
    world.db.seed(`businesses/${H}/payrolls/${payrollId}`, { ...payroll(payrollId), additions: [], basePay: 1 });
    expect((await receipt({ action: "view", token: r.body.receiptToken }, helper)).body.receipt.rows.map((x) => x.amount)).toEqual([before.basePay, 100000, -50000, -20000, 120000]);
  });

  it("Confirm received records once with the evidence; the Owner sees who, how and when; reopening creates nothing new", async () => {
    const { id, payrollId, r } = await released();
    const helper = await mariaLogin(id);
    const before = structuredClone(payroll(payrollId));
    const c = await receipt({ action: "confirm", token: r.body.receiptToken }, helper);
    expect(c.status).toBe(200);
    expect(c.body.receipt).toMatchObject({ receiptStatus: "confirmed", confirmed: true, netPay: 720000 });
    const after = payroll(payrollId);
    expect(after).toMatchObject({ receiptStatus: "confirmed", receiptConfirmedVia: "staff-account", receiptConfirmedBy: { uid: helper, name: "Maria" } });
    expect(after.receiptConfirmation).toMatchObject({ businessId: H, staffId: id, payrollId, paymentId: null, uid: helper, staffName: "Maria", method: "kasambahay-account", status: "confirmed", receiptLinkRef: after.receiptLinkHash });
    expect(after.receiptConfirmation.confirmedAt).toBeInstanceOf(Date);
    // Confirming touches only the receipt, never the salary.
    for (const k of ["status", "salary", "netPay", "basePay", "deductions", "deductionsTotal"]) expect(after[k], k).toEqual(before[k]);
    const audits = () => [...world.db.docs.entries()].filter(([k, v]) => k.startsWith(`businesses/${H}/auditLog/`) && v.type === "payroll.receipt_confirmed");
    expect(audits()).toHaveLength(1);
    for (const who of ["mom", "dad"]) expect(world.db.docs.get(`businesses/${H}/members/${u[who]}/inbox/${notificationId("payroll.receipt_confirmed", payrollId)}`), who).toMatchObject({ title: "Salary receipt confirmed", message: "Maria confirmed receiving ₱7,200.00 for 2026-10-01 to 2026-10-15." });
    // Reopened and tapped again: already confirmed, nothing new.
    const evidence = structuredClone(after.receiptConfirmation);
    expect((await receipt({ action: "view", token: r.body.receiptToken }, helper)).body.receipt.receiptStatus).toBe("confirmed");
    expect((await receipt({ action: "confirm", token: r.body.receiptToken }, helper)).body.receipt.alreadyConfirmed).toBe(true);
    expect(audits()).toHaveLength(1);
    expect(payroll(payrollId).receiptConfirmation).toEqual(evidence);
    const owner = await api("payroll", u.mom, { action: "period", period: { start: "2026-10-01", end: "2026-10-15" }, staffId: id });
    expect(owner.body.view.rows[0].receiptView).toMatchObject({ status: "confirmed", confirmedBy: "Maria", verifiedVia: "Kasambahay account" });
    expect(owner.body.view.rows[0].receiptView.confirmedAt).toBe(evidence.confirmedAt.toISOString());
  });

  it("the wrong account can't see or confirm it: Owner, Admin, a staff user, another helper, another household's owner", async () => {
    const { id, payrollId, r } = await released();
    await mariaLogin(id);
    const rosa = await maria({ name: "Rosa" });
    const rosaUid = await mariaLogin(rosa);
    const B = "biz-home-b";
    await createBusiness({ ...world, name: "Reyes Household", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: B });
    const other = await ensureAuthUser({ auth: world.auth, email: "reyes@home.test", name: "reyes" });
    await addMember({ ...world, businessId: B, uid: other.uid, email: other.email, name: "reyes", roleTemplate: "owner", isAccountOwner: true });
    for (const uid of [u.mom, u.dad, u.helper, rosaUid, other.uid]) {
      for (const action of ["view", "confirm"]) {
        const res = await receipt({ action, token: r.body.receiptToken }, uid);
        expect(res, `${uid} ${action}`).toMatchObject({ status: 403, body: { error: "receipt-not-yours", message: NOT_YOURS_MESSAGE } });
        expect(JSON.stringify(res.body)).not.toMatch(/Maria|7,200|720000|Santos/);
      }
    }
    expect(payroll(payrollId)).toMatchObject({ receiptStatus: "awaiting" });
    expect(payroll(payrollId).receiptOpenedAt).toBeUndefined();
  });

  it("garbage, unknown and replaced tokens all get the same 404; expired links 410; a new link works", async () => {
    const { id, payrollId, r } = await released();
    const helper = await mariaLogin(id);
    const msg = "This link isn't valid. Ask your employer for a new one.";
    for (const token of ["x", "A".repeat(32), "../../etc", undefined]) expect(await receipt({ action: "view", token }, helper)).toMatchObject({ status: 404, body: { message: msg } });
    const fresh = await api("payroll", u.mom, { action: "newReceiptLink", payrollId });
    expect(await receipt({ action: "view", token: r.body.receiptToken }, helper)).toMatchObject({ status: 404, body: { message: msg } });
    clock = new Date(NOW.getTime() + 15 * 86400000);
    expect((await receipt({ action: "view", token: fresh.body.receiptToken }, helper)).body.receipt.expired).toBe(true);
    expect((await receipt({ action: "confirm", token: fresh.body.receiptToken }, helper)).status).toBe(410);
    const newest = await api("payroll", u.mom, { action: "newReceiptLink", payrollId });
    expect((await receipt({ action: "confirm", token: newest.body.receiptToken }, helper)).status).toBe(200);
    expect((await api("payroll", u.mom, { action: "newReceiptLink", payrollId })).body.error).toBe("receipt-not-awaited");
  });

  it("a receipt token is not a Luna login: it opens nothing in the workspace", async () => {
    const { r } = await released();
    for (const [kind, body] of [["payroll", { action: "prepare", staffId: "aaaaaaaaaaaa", periodStart: "2026-10-01" }], ["staff", { action: "create", staff: { name: "X", dailyWage: 1, payCycle: "weekly" } }]]) {
      const res = await HANDLERS[kind](deps())({ ...request({ token: r.body.receiptToken, businessId: H, method: "POST" }), body: JSON.stringify(body) });
      expect(res.statusCode, kind).toBe(401);
    }
    const ex = await createExportsHandler(deps())({ ...request({ token: r.body.receiptToken, businessId: H, method: "POST" }), body: JSON.stringify({ dataset: "payroll" }) });
    expect(ex.statusCode).toBe(401);
  });

  it("a link document that isn't the payroll's CURRENT link is refused (defence in depth)", async () => {
    const { id, payrollId } = await released();
    const helper = await mariaLogin(id);
    const { createHash } = await import("node:crypto");
    const stray = "StrayTokenStrayTokenStrayToken01";
    world.db.seed(`receiptLinks/${createHash("sha256").update(stray).digest("hex")}`, { businessId: H, payrollId, expiresAt: new Date(NOW.getTime() + 86400000), usedAt: null });
    expect((await receipt({ action: "view", token: stray }, helper)).status).toBe(404);
    expect((await receipt({ action: "confirm", token: stray }, helper)).status).toBe(404);
    expect(payroll(payrollId).receiptStatus).toBe("awaiting");
  });

  it("release may be early (Owner-pilot batch), refuses a negative net pay, and only once", async () => {
    const id = await maria();
    const { payrollId } = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-16" })).body;
    // Paid on Oct 16 for Oct 16-31: an early salary payment, allowed and labelled.
    const early = await api("payroll", u.mom, { action: "release", payrollId, payment: { method: "cash" } });
    expect(early.status).toBe(200);
    expect(payroll(payrollId)).toMatchObject({ status: "released", paymentTiming: "early", salary: { paidDate: "2026-10-16", timing: "early" } });
    const id2 = await maria({ name: "Rosa" });
    await mark(id2, "2026-10-01", "present");
    const p2 = (await api("payroll", u.mom, { action: "prepare", staffId: id2, periodStart: "2026-10-01" })).body.payrollId;
    await api("payroll", u.mom, { action: "addDeduction", payrollId: p2, deduction: { description: "Loan", amount: 100000 } });
    expect((await api("payroll", u.mom, { action: "release", payrollId: p2, payment: { method: "cash" } })).body.error).toBe("negative-net-pay");
    await api("payroll", u.mom, { action: "addDeduction", payrollId: p2, deduction: { description: "x", amount: 1 } });
    const ok = await maria({ name: "Ana" });
    const p3 = (await api("payroll", u.mom, { action: "prepare", staffId: ok, periodStart: "2026-10-01" })).body.payrollId;
    expect((await api("payroll", u.mom, { action: "release", payrollId: p3, payment: { method: "cash" } })).status).toBe(200);
    expect((await api("payroll", u.mom, { action: "release", payrollId: p3, payment: { method: "cash" } })).body.error).toBe("payroll-released");
    expect((await api("payroll", u.mom, { action: "release", payrollId: p3, payment: { method: "barter" } })).status).toBe(400);
  });
});

describe("access", () => {
  it("household staff role (no payroll permissions) is refused everywhere; manager can do it all", async () => {
    const id = await maria();
    expect((await mark(id, "2026-10-02", "present", u.helper)).status).toBe(403);
    expect((await api("payroll", u.helper, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).status).toBe(403);
    expect((await api("advances", u.helper, { action: "create", advance: { staffId: id, date: "2026-10-01", amount: 1 } })).status).toBe(403);
    expect((await api("staff", u.helper, { action: "create", staff: { name: "X", dailyWage: 1, payCycle: "weekly" } })).status).toBe(403);
    expect((await mark(id, "2026-10-02", "present", u.dad)).status).toBe(200);
  });

  it("a Distributor business has none of it (workspace ceiling); B can't reach the household", async () => {
    expect((await api("staff", world.uids.ownera, { action: "create", staff: { name: "X", dailyWage: 1, payCycle: "weekly" } }, "biz-a")).status).toBe(403);
    expect((await api("payroll", world.uids.ownera, { action: "prepare", staffId: "aaaaaaaaaaaa", periodStart: "2026-10-01" }, "biz-a")).status).toBe(403);
    expect((await api("staff", world.uids.ownera, { action: "create", staff: { name: "X", dailyWage: 1, payCycle: "weekly" } }, H)).body.error).toBe("business-access-denied");
  });

  it("401 without a token; unknown actions and fields 400; browser can't send computed fields", async () => {
    expect((await createPayrollHandler(deps())({ ...request({ method: "POST" }), body: "{}" })).statusCode).toBe(401);
    expect((await api("payroll", u.mom, { action: "markReceived", payrollId: "x" })).status).toBe(400);
    expect((await api("staff", u.mom, { action: "create", staff: { name: "X", dailyWage: 1, payCycle: "weekly", basePay: 5 } })).status).toBe(400);
    expect((await api("payroll", u.mom, { action: "prepare", staffId: "aaaaaaaaaaaa", periodStart: "2026-10-01", netPay: 1 })).status).toBe(400);
  });

  it("the receipt endpoint accepts only {action, token}", async () => {
    expect((await receipt({ action: "confirm", token: "x", businessId: H }, u.helper)).status).toBe(400);
    expect((await receipt({ action: "list" }, u.helper)).status).toBe(400);
  });
});

describe("Excel downloads (Phase 12.5 Export Core)", () => {
  async function xport(uid, dataset, filters, businessId = H) {
    const res = await createExportsHandler({ getAdmin: async () => world, now: () => clock })({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify({ dataset, filters }) });
    return res.statusCode === 200 ? { status: 200, bytes: new Uint8Array(Buffer.from(res.body, "base64")), headers: res.headers } : { status: res.statusCode, body: JSON.parse(res.body) };
  }
  // Phase 18.6: one worksheet; [header, ...rows] under its title block.
  const sheet = (bytes, name) => {
    expect(() => readXlsx(bytes, { sheet: "Export info" })).toThrow();
    return reportRows(readXlsx(bytes, { sheet: name }).rows);
  };

  it("Employee = Maria, Periods Oct 1-15 -> ONE sheet: her payroll row, its deduction and the 15 attendance days", async () => {
    const id = await maria();
    const other = await maria({ name: "Rosa" });
    await markPeriod(id, "2026-10-01", OCT_1_15);
    await mark(other, "2026-10-02", "present");
    const a = (await api("advances", u.mom, { action: "create", advance: { staffId: id, date: "2026-10-05", amount: 50000 } })).body.advanceId;
    await api("advances", u.mom, { action: "markPaid", advanceId: a, release: { paidDate: "2026-10-05" } });
    await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" });
    await api("payroll", u.mom, { action: "prepare", staffId: other, periodStart: "2026-10-01" });
    const r = await xport(u.mom, "payroll", { staffId: id, from: "2026-10-01", to: "2026-10-01" });
    expect(r.status).toBe(200);
    const all = sheet(r.bytes, "Payroll");
    const h = all[0];
    const of = (type) => all.slice(1).filter((x) => x[0] === type).map((x) => Object.fromEntries(h.map((k, i) => [k, x[i]])));
    expect(of("Payroll")).toHaveLength(1);
    expect(of("Payroll")[0]).toMatchObject({ Employee: "Maria", "Employee ID": id, "Employment status": "Active", Present: "10", "Paid leave": "2", Absent: "3", "Basic pay": "7200", "Advances deducted": "500", "Gross pay": "7200", "Net pay": "6700", "Owner payment": "Not paid", "Advance balance left (now)": "500" });
    expect(of("Advance deduction").map((d) => d["Line amount"])).toEqual(["500"]);
    const days = of("Attendance");
    expect(days).toHaveLength(15);
    expect(days.every((l) => l.Employee === "Maria")).toBe(true);
    expect([days[0].Date, days[0].Item, days[0]["Line amount"]]).toEqual(["46296", "Thu · Present", "600"]);
    // Totals add the Payroll row only (details sit in Line amount, untotalled).
    const total = readXlsx(r.bytes, { sheet: "Payroll" }).rows.at(-1);
    expect([total[0], total[h.indexOf("Basic pay")], total[h.indexOf("Net pay")], total[h.indexOf("Line amount")] ?? ""]).toEqual(["Total", "7200", "6700", ""]);
  });

  it("attendance and advances follow their filters; staff and advances download", async () => {
    const id = await maria();
    await markPeriod(id, "2026-10-01", OCT_1_15);
    const abs = await xport(u.dad, "attendance", { staffId: id, status: "absent", from: "2026-10-01", to: "2026-10-15" });
    expect(sheet(abs.bytes, "Attendance").slice(1).map((l) => l[4])).toEqual(["Absent", "Absent", "Absent"]);
    await api("advances", u.mom, { action: "create", advance: { staffId: id, date: "2026-10-05", amount: 50000 } });
    const adv = sheet((await xport(u.mom, "advances", { status: "not_yet_paid" })).bytes, "Advances");
    expect(adv.slice(1)[0][adv[0].indexOf("Status")]).toBe("Approved, not released");
    const staff = sheet((await xport(u.mom, "householdStaff", {})).bytes, "Household Staff");
    expect(staff.slice(1)[0].slice(0, 4)).toEqual(["Maria", id, "Kasambahay", "600"]);
  });

  it("refused: household staff role (no data.export / views), a Distributor business, bad filters", async () => {
    expect((await xport(u.helper, "payroll", {})).status).toBe(403);
    expect((await xport(world.uids.ownera, "payroll", {}, "biz-a")).status).toBe(403);
    expect((await xport(world.uids.ownera, "attendance", {}, "biz-a")).status).toBe(403);
    expect((await xport(u.mom, "payroll", { staffId: "../x" })).status).toBe(400);
    expect((await xport(u.mom, "payroll", { employee: "Maria" })).status).toBe(400);
  });
});

describe("Phase 18 usage metering (meter only, never enforced)", () => {
  const usage = () => docAt("usage/2026-10") || {};
  it("a released salary counts one payroll run; a prepared-then-deleted draft never counts", async () => {
    const id = await maria();
    await markPeriod(id, "2026-10-01", OCT_1_15);
    const draft = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).body.payrollId;
    expect((await api("payroll", u.mom, { action: "deleteDraft", payrollId: draft })).status).toBe(200);
    expect(usage().payrollsReleased).toBeUndefined();
    const { payrollId } = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).body;
    expect((await api("payroll", u.mom, { action: "release", payrollId, payment: { method: "cash" } })).status).toBe(200);
    expect((await api("payroll", u.mom, { action: "release", payrollId, payment: { method: "cash" } })).status).not.toBe(200);
    expect(usage()).toMatchObject({ payrollsReleased: 1, timezone: "Asia/Manila" });
  });
});
