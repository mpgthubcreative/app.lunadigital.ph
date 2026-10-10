// Phase 14: Household / Kasambahay Payroll on the server: staff, daily
// attendance (Present / Absent / Official Leave), payroll (payable days,
// base pay, advances deducted in full, manual deductions, net pay), salary
// release, the one-time receipt link, notifications, and access.

import { describe, it, expect, beforeEach } from "vitest";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createReceiptHandler } from "../../netlify/functions/receipt.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { notificationId } from "../../shared/notifications.js";
import { addDays } from "../../shared/metrics.js";
import { createExportsHandler } from "../../netlify/functions/exports.js";
import { readXlsx } from "../../shared/xlsx.js";

const NOW = new Date("2026-10-16T04:00:00Z"); // Oct 16, 12:00 Manila
const H = "biz-home";
let world;
let u;
let clock;

beforeEach(async () => {
  world = await buildWorld();
  clock = NOW;
  await createBusiness({ ...world, name: "Santos Household", planId: "growth", workspaceTemplateId: "household-payroll", businessId: H });
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
async function receipt(body) {
  const res = await createReceiptHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });
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
    expect((await mark(id, "2026-10-04", "rest_day")).body.error).toBe("invalid-status");
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
    // marked paid while the draft is open: joins it now
    await api("advances", u.mom, { action: "markPaid", advanceId: notPaid, release: { method: "gcash", reference: "GC123" } });
    expect(payroll(payrollId)).toMatchObject({ deductionsTotal: 30000, netPay: 720000 - 30000 });
    expect(docAt(`advances/${notPaid}`)).toMatchObject({ status: "paid", method: "gcash", reference: "GC123", paidDate: "2026-10-16", deductionPayrollId: payrollId });
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
    await api("advances", u.mom, { action: "markPaid", advanceId: a });
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
    await api("advances", u.mom, { action: "markPaid", advanceId: a });
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

  it("the employee sees only what was paid, confirms once; owner and manager are notified", async () => {
    const { payrollId, r } = await released();
    const view = await receipt({ action: "view", token: r.body.receiptToken });
    expect(view.body.receipt).toEqual({ businessName: "Santos Household", employeeName: "Maria", period: { start: "2026-10-01", end: "2026-10-15" }, amount: 720000, method: "GCash", paidDate: "2026-10-16", receiptStatus: "awaiting", expired: false });
    const before = structuredClone(payroll(payrollId));
    const c = await receipt({ action: "confirm", token: r.body.receiptToken });
    expect(c.body.receipt).toMatchObject({ receiptStatus: "confirmed", confirmed: true });
    const after = payroll(payrollId);
    expect(after).toMatchObject({ receiptStatus: "confirmed", receiptConfirmedVia: "employee-link" });
    // calculated -> paid -> confirmed: confirming touches only the receipt, never the salary
    for (const k of ["status", "salary", "netPay", "basePay", "deductions", "deductionsTotal"]) expect(after[k], k).toEqual(before[k]);
    expect(after.history.at(-1)).toMatchObject({ actor: null, via: "employee-link", label: "Maria confirmed receipt" });
    for (const who of ["mom", "dad"]) expect(world.db.docs.get(`businesses/${H}/members/${u[who]}/inbox/${notificationId("payroll.receipt_confirmed", payrollId)}`), who).toMatchObject({ title: "Salary receipt confirmed", message: "Maria confirmed receiving ₱7,200.00 for 2026-10-01 to 2026-10-15." });
    expect(world.db.docs.get(`businesses/${H}/members/${u.helper}/inbox/${notificationId("payroll.receipt_confirmed", payrollId)}`)).toBeUndefined();
    // again: already confirmed, nothing changes, no second notification
    expect((await receipt({ action: "confirm", token: r.body.receiptToken })).body.receipt.alreadyConfirmed).toBe(true);
  });

  it("garbage, unknown and replaced tokens all get the same 404; expired links 410; a new link works", async () => {
    const { payrollId, r } = await released();
    const msg = "This link isn't valid. Ask your employer for a new one.";
    for (const token of ["x", "A".repeat(32), "../../etc", undefined]) expect(await receipt({ action: "view", token })).toMatchObject({ status: 404, body: { message: msg } });
    const fresh = await api("payroll", u.mom, { action: "newReceiptLink", payrollId });
    expect(await receipt({ action: "view", token: r.body.receiptToken })).toMatchObject({ status: 404, body: { message: msg } });
    clock = new Date(NOW.getTime() + 15 * 86400000);
    expect((await receipt({ action: "view", token: fresh.body.receiptToken })).body.receipt.expired).toBe(true);
    expect((await receipt({ action: "confirm", token: fresh.body.receiptToken })).status).toBe(410);
    const newest = await api("payroll", u.mom, { action: "newReceiptLink", payrollId });
    expect((await receipt({ action: "confirm", token: newest.body.receiptToken })).status).toBe(200);
    expect((await api("payroll", u.mom, { action: "newReceiptLink", payrollId })).body.error).toBe("receipt-not-awaited");
  });

  it("a token reaches only its own payment: household B's link never shows or confirms A's", async () => {
    const a = await released();
    const B = "biz-home-b";
    await createBusiness({ ...world, name: "Reyes Household", planId: "growth", workspaceTemplateId: "household-payroll", businessId: B });
    const owner = await ensureAuthUser({ auth: world.auth, email: "reyes@home.test", name: "reyes" });
    await addMember({ ...world, businessId: B, uid: owner.uid, email: owner.email, name: "reyes", roleTemplate: "owner", isAccountOwner: true });
    const rosa = (await api("staff", owner.uid, { action: "create", staff: { name: "Rosa", dailyWage: 50000, payCycle: "semi_monthly" } }, B)).body.staffId;
    await api("attendance", owner.uid, { action: "set", staffId: rosa, date: "2026-10-01", status: "present" }, B);
    const pb = (await api("payroll", owner.uid, { action: "prepare", staffId: rosa, periodStart: "2026-10-01" }, B)).body.payrollId;
    const rb = await api("payroll", owner.uid, { action: "release", payrollId: pb, payment: { method: "cash" } }, B);
    expect((await receipt({ action: "view", token: a.r.body.receiptToken })).body.receipt).toMatchObject({ businessName: "Santos Household", employeeName: "Maria", amount: 720000 });
    expect((await receipt({ action: "view", token: rb.body.receiptToken })).body.receipt).toMatchObject({ businessName: "Reyes Household", employeeName: "Rosa", amount: 50000 });
    expect((await receipt({ action: "confirm", token: rb.body.receiptToken })).status).toBe(200);
    expect(world.db.docs.get(`businesses/${B}/payrolls/${pb}`).receiptStatus).toBe("confirmed");
    expect(payroll(a.payrollId).receiptStatus).toBe("awaiting");
    expect(JSON.stringify((await receipt({ action: "view", token: rb.body.receiptToken })).body)).not.toMatch(/Santos|Maria|biz-home"/);
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
    const { payrollId } = await released();
    const { createHash } = await import("node:crypto");
    const stray = "StrayTokenStrayTokenStrayToken01";
    world.db.seed(`receiptLinks/${createHash("sha256").update(stray).digest("hex")}`, { businessId: H, payrollId, expiresAt: new Date(NOW.getTime() + 86400000), usedAt: null });
    expect((await receipt({ action: "view", token: stray })).status).toBe(404);
    expect((await receipt({ action: "confirm", token: stray })).status).toBe(404);
    expect(payroll(payrollId).receiptStatus).toBe("awaiting");
  });

  it("release waits for the period's last day, refuses a negative net pay, and only once", async () => {
    const id = await maria();
    const { payrollId } = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-16" })).body;
    expect((await api("payroll", u.mom, { action: "release", payrollId, payment: { method: "cash" } })).body.error).toBe("period-not-ended");
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

  it("the public receipt endpoint accepts only {action, token}", async () => {
    expect((await receipt({ action: "confirm", token: "x", businessId: H })).status).toBe(400);
    expect((await receipt({ action: "list" })).status).toBe(400);
  });
});

describe("Excel downloads (Phase 12.5 Export Core)", () => {
  async function xport(uid, dataset, filters, businessId = H) {
    const res = await createExportsHandler({ getAdmin: async () => world, now: () => clock })({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify({ dataset, filters }) });
    return res.statusCode === 200 ? { status: 200, bytes: new Uint8Array(Buffer.from(res.body, "base64")), headers: res.headers } : { status: res.statusCode, body: JSON.parse(res.body) };
  }
  const sheet = (bytes, name) => readXlsx(bytes, { sheet: name }).rows;

  it("Employee = Maria, Periods Oct 1-15 -> her payroll, its deduction and the 15 attendance lines behind it", async () => {
    const id = await maria();
    const other = await maria({ name: "Rosa" });
    await markPeriod(id, "2026-10-01", OCT_1_15);
    await mark(other, "2026-10-02", "present");
    const a = (await api("advances", u.mom, { action: "create", advance: { staffId: id, date: "2026-10-05", amount: 50000 } })).body.advanceId;
    await api("advances", u.mom, { action: "markPaid", advanceId: a });
    await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" });
    await api("payroll", u.mom, { action: "prepare", staffId: other, periodStart: "2026-10-01" });
    const r = await xport(u.mom, "payroll", { staffId: id, from: "2026-10-01", to: "2026-10-01" });
    expect(r.status).toBe(200);
    const p = sheet(r.bytes, "Payroll");
    expect(p).toHaveLength(2);
    const row = Object.fromEntries(p[0].map((h, i) => [h, p[1][i]]));
    expect(row).toMatchObject({ Employee: "Maria", Present: "10", "Official Leave": "2", Absent: "3", "Payable days": "12", "Base pay": "7200", Deductions: "500", "Net pay": "6700", Salary: "Not yet paid" });
    expect(sheet(r.bytes, "Deductions").slice(1).map((d) => d[4])).toEqual(["500"]);
    const lines = sheet(r.bytes, "Attendance").slice(1);
    expect(lines).toHaveLength(15);
    expect(lines.every((l) => l[2] === "Maria")).toBe(true);
    expect(lines[0].slice(0, 6)).toEqual(["46296", "Thu", "Maria", "Present", "600", "600"]);
  });

  it("attendance and advances follow their filters; staff and advances download", async () => {
    const id = await maria();
    await markPeriod(id, "2026-10-01", OCT_1_15);
    const abs = await xport(u.dad, "attendance", { staffId: id, status: "absent", from: "2026-10-01", to: "2026-10-15" });
    expect(sheet(abs.bytes, "Attendance").slice(1).map((l) => l[3])).toEqual(["Absent", "Absent", "Absent"]);
    await api("advances", u.mom, { action: "create", advance: { staffId: id, date: "2026-10-05", amount: 50000 } });
    expect(sheet((await xport(u.mom, "advances", { status: "not_yet_paid" })).bytes, "Advances").slice(1)[0][4]).toBe("Not Yet Paid");
    expect(sheet((await xport(u.mom, "householdStaff", {})).bytes, "Household Staff").slice(1)[0].slice(0, 3)).toEqual(["Maria", "Kasambahay", "600"]);
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
