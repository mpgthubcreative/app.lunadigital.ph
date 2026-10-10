// Phase 18.6: household staff accounts and self-service. The Owner creates
// a login (activation link, the person sets their own password); the staff
// member asks for attendance / leave / advances and confirms salaries from
// their own account; nothing they send changes pay until the Owner approves.

import { describe, it, expect, beforeEach } from "vitest";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createMeHandler } from "../../netlify/functions/me.js";
import { createActivateHandler } from "../../netlify/functions/activate.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { STAFF_LOGIN_DOMAIN } from "../../netlify/functions/_lib/activation.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { notificationId } from "../../shared/notifications.js";

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
  for (const [key, role] of [["mom", "owner"], ["dad", "manager"]]) {
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
async function me(uid, body = null) {
  const res = await createMeHandler(deps())({ ...request({ uid, businessId: H, method: body ? "POST" : "GET" }), ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function activate(body) {
  const res = await createActivateHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const docAt = (p) => world.db.docs.get(`businesses/${H}/${p}`);

async function staff(name = "Maria Santos", extra = {}) {
  const r = await api("staff", u.mom, { action: "create", staff: { name, position: "Kasambahay", dailyWage: 60000, payCycle: "semi_monthly", ...extra } });
  expect(r.status).toBe(201);
  return r.body.staffId;
}
// Creates the login and activates it; returns the staff member's uid.
async function withLogin(staffId) {
  const r = await api("staff", u.mom, { action: "createLogin", staffId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect((await activate({ action: "activate", token: r.body.activationToken, password: "kape-at-pandesal" })).status).toBe(200);
  return r.body.uid;
}

describe("staff logins: activation links, never a password the Owner knows", () => {
  it("no email -> a login ID; the link shows once; the person sets their own password; the link then stops working", async () => {
    const id = await staff();
    const r = await api("staff", u.mom, { action: "createLogin", staffId: id });
    expect(r.status).toBe(201);
    expect(r.body.login).toMatch(/^maria\.\d{4}$/);
    expect(r.body.activationToken).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(JSON.stringify(r.body)).not.toMatch(/password/i);
    const member = docAt(`members/${r.body.uid}`);
    expect(member).toMatchObject({ roleTemplate: "household_staff", staffId: id, status: "active", activation: { status: "pending" }, email: `${r.body.login}@${STAFF_LOGIN_DOMAIN}` });
    expect(Object.keys(member.permissions).sort()).toEqual(["advances.self", "attendance.self", "payroll.self"]);
    expect(docAt(`householdStaff/${id}`)).toMatchObject({ memberUid: r.body.uid, login: { login: r.body.login, status: "pending" } });
    // Only the hash is stored.
    expect([...world.db.docs.keys()].some((k) => k.includes(r.body.activationToken))).toBe(false);

    const view = await activate({ action: "view", token: r.body.activationToken });
    expect(view.body.activation).toEqual({ businessName: "Santos Household", name: "Maria Santos", login: r.body.login, usesLoginId: true, used: false, expired: false });
    expect((await activate({ action: "activate", token: r.body.activationToken, password: "short" })).body.error).toBe("weak-password");
    expect((await activate({ action: "activate", token: r.body.activationToken, password: "kape-at-pandesal" })).status).toBe(200);
    expect((await world.auth.getUser(r.body.uid)).password).toBe("kape-at-pandesal");
    expect(docAt(`members/${r.body.uid}`).activation.status).toBe("active");
    expect(docAt(`householdStaff/${id}`).login.status).toBe("active");
    expect((await activate({ action: "activate", token: r.body.activationToken, password: "another-one-123" })).body.error).toBe("link-used");
    expect((await activate({ action: "view", token: "x".repeat(32) })).status).toBe(404);
  });

  it("a new link replaces the old one, signs the person out, and only works once; expired links refuse", async () => {
    const id = await staff();
    const first = (await api("staff", u.mom, { action: "createLogin", staffId: id })).body;
    const second = await api("staff", u.mom, { action: "newLink", staffId: id });
    expect(second.status).toBe(200);
    expect((await activate({ action: "view", token: first.activationToken })).status).toBe(404);
    expect(world.auth.revoked).toContain(first.uid);
    clock = new Date(NOW.getTime() + 8 * 86_400_000);
    expect((await activate({ action: "activate", token: second.body.activationToken, password: "kape-at-pandesal" })).body.error).toBe("link-expired");
  });

  it("an existing Luna account is linked as is (no link); one login per person; only Owners with users.manage", async () => {
    const id = await staff();
    await ensureAuthUser({ auth: world.auth, email: "maria@gmail.test", name: "Maria" });
    const r = await api("staff", u.mom, { action: "createLogin", staffId: id, email: "maria@gmail.test" });
    expect(r.body).toMatchObject({ existingAccount: true, login: "maria@gmail.test" });
    expect(r.body.activationToken).toBeUndefined();
    expect((await api("staff", u.mom, { action: "createLogin", staffId: id })).body.error).toBe("has-login");
    const other = await staff("Lito");
    expect((await api("staff", u.dad, { action: "createLogin", staffId: other })).status).toBe(403); // manager: no users.manage
  });

  it("turning the login off removes access and signs them out", async () => {
    const id = await staff();
    const uid = await withLogin(id);
    expect((await api("staff", u.mom, { action: "setLogin", staffId: id, enabled: false })).status).toBe(200);
    expect(docAt(`members/${uid}`).status).toBe("disabled");
    expect((await me(uid)).status).toBe(403);
  });
});

describe("self-service: their own record only; requests change nothing until approved", () => {
  it("Present / Paid Leave / Rest Day requests wait for the Owner; approval marks the day, rejection doesn't", async () => {
    const id = await staff();
    const uid = await withLogin(id);
    const r1 = await me(uid, { action: "attendance", date: "2026-10-16", status: "present" });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.state).toBe("pending");
    expect(docAt(`attendance/${id}_2026-10-16`)).toBeUndefined();
    // The Owner was told.
    expect(docAt(`members/${u.mom}/inbox/${notificationId("household.attendance_request", `${id}_2026-10-16-1`)}`)).toMatchObject({ title: "Maria Santos: Present on 2026-10-16" });
    // Planned leave ahead is fine; Present ahead isn't.
    expect((await me(uid, { action: "attendance", date: "2026-10-24", status: "official_leave", note: "Fiesta sa probinsya" })).status).toBe(200);
    expect((await me(uid, { action: "attendance", date: "2026-10-20", status: "present" })).body.error).toBe("invalid-date");

    expect((await api("attendance", u.mom, { action: "decide", requestId: `${id}_2026-10-16`, decision: { decision: "approve" } })).status).toBe(200);
    expect(docAt(`attendance/${id}_2026-10-16`)).toMatchObject({ status: "present", payable: true });
    expect(docAt(`attendanceRequests/${id}_2026-10-16`)).toMatchObject({ state: "approved", decidedBy: { uid: u.mom } });
    expect((await api("attendance", u.mom, { action: "decide", requestId: `${id}_2026-10-16`, decision: { decision: "approve" } })).body.error).toBe("request-decided");
    expect((await api("attendance", u.mom, { action: "decide", requestId: `${id}_2026-10-24`, decision: { decision: "reject", note: "Busy week" } })).status).toBe(200);
    expect(docAt(`attendance/${id}_2026-10-24`)).toBeUndefined();

    const view = (await me(uid)).body.me;
    expect(view.staff.name).toBe("Maria Santos");
    expect(view.todayStatus).toBe("present");
    expect(view.requests.find((r) => r.date === "2026-10-24")).toMatchObject({ state: "rejected", answer: "Busy week", statusLabel: "Paid Leave" });
  });

  it("a staff account can't reach the Owner's tools or anyone else's records", async () => {
    const id = await staff();
    const other = await staff("Lito Cruz");
    const uid = await withLogin(id);
    expect((await api("attendance", uid, { action: "set", staffId: other, date: "2026-10-16", status: "present" })).status).toBe(403);
    expect((await api("advances", uid, { action: "create", advance: { staffId: id, date: "2026-10-16", amount: 100 } })).status).toBe(403);
    // A request can't name another person: there's no staffId field at all.
    expect((await me(uid, { action: "attendance", staffId: other, date: "2026-10-16", status: "present" })).status).toBe(400);
    // Another person's salary id is refused.
    await api("attendance", u.mom, { action: "set", staffId: other, date: "2026-10-01", status: "present" });
    const p = (await api("payroll", u.mom, { action: "prepare", staffId: other, periodStart: "2026-10-01" })).body.payrollId;
    await api("payroll", u.mom, { action: "release", payrollId: p, payment: { method: "cash" } });
    expect((await me(uid, { action: "received", payrollId: p })).body.error).toBe("not-found");
    expect(JSON.stringify((await me(uid)).body)).not.toMatch(/Lito/);
    // A manager isn't linked to a staff record.
    expect((await me(u.dad)).body.error).toBe("not-linked");
  });
});

describe("cash advances: requested -> approved -> released -> deducted by installment", () => {
  it("approval isn't money; each payroll deducts the installment; the balance is tracked; never deducted twice", async () => {
    const id = await staff();
    const uid = await withLogin(id);
    const req = await me(uid, { action: "advance", amount: 300000, reason: "School fees" });
    expect(req.body).toMatchObject({ status: "requested" });
    const aid = req.body.advanceId;
    expect(docAt(`members/${u.mom}/inbox/${notificationId("household.advance_request", aid)}`)).toBeTruthy();
    // Not approved yet: can't be released.
    expect((await api("advances", u.mom, { action: "markPaid", advanceId: aid, release: { method: "cash" } })).body.error).toBe("advance-not-approved");
    expect((await api("advances", u.mom, { action: "decide", advanceId: aid, decision: { decision: "approve" }, approval: { amount: 200000, installment: 50000 } })).status).toBe(200);
    expect(docAt(`advances/${aid}`)).toMatchObject({ status: "not_yet_paid", requestedAmount: 300000, amount: 200000, installment: 50000 });
    expect((await api("advances", u.mom, { action: "markPaid", advanceId: aid, release: { paidDate: "2026-10-01", method: "gcash", reference: "GC-1" } })).status).toBe(200);

    // Oct 1-15: 10 days present -> ₱6,000 basic; ₱500 deducted.
    for (let d = 1; d <= 10; d++) await api("attendance", u.mom, { action: "set", staffId: id, date: `2026-10-${String(d).padStart(2, "0")}`, status: "present" });
    const p1 = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).body.payrollId;
    expect(docAt(`payrolls/${p1}`)).toMatchObject({ basePay: 600000, deductionsTotal: 50000, netPay: 550000, grossPay: 600000 });
    expect((await api("payroll", u.mom, { action: "release", payrollId: p1, payment: { method: "cash" } })).status).toBe(200);
    expect(docAt(`advances/${aid}`)).toMatchObject({ deductedAmount: 50000, deducted: false, deductionPayrollId: null });
    const view = (await me(uid)).body.me;
    expect(view.advances[0]).toMatchObject({ amount: 200000, requested: 300000, remaining: 150000, deducted: 50000, installment: 50000, statusLabel: "Released" });
    // The next payroll deducts the next installment, once.
    clock = new Date("2026-11-01T04:00:00Z");
    const p2 = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-16" })).body.payrollId;
    expect(docAt(`payrolls/${p2}`).deductions.map((d) => d.amount)).toEqual([50000]);
    expect(docAt(`payrolls/${p2}`).deductions[0].description).toMatch(/₱500.00 of ₱1,500.00 left/);
  });

  it("a rejected request is never released or deducted", async () => {
    const id = await staff();
    const uid = await withLogin(id);
    const aid = (await me(uid, { action: "advance", amount: 100000 })).body.advanceId;
    expect((await api("advances", u.mom, { action: "decide", advanceId: aid, decision: { decision: "reject", note: "Next month" } })).status).toBe(200);
    expect((await api("advances", u.mom, { action: "markPaid", advanceId: aid, release: { method: "cash" } })).body.error).toBe("advance-not-approved");
    expect((await me(uid)).body.me.advances[0]).toMatchObject({ status: "rejected", answer: "Next month" });
  });
});

describe("salary received: the employee's confirmation is separate from the Owner's payment", () => {
  async function paidSalary(id) {
    await api("attendance", u.mom, { action: "set", staffId: id, date: "2026-10-02", status: "present" });
    const p = (await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: "2026-10-01" })).body.payrollId;
    return p;
  }
  it("can't confirm before the Owner marks it paid; confirming keeps the payment as recorded and retires the receipt link", async () => {
    const id = await staff();
    const uid = await withLogin(id);
    const p = await paidSalary(id);
    expect((await me(uid, { action: "received", payrollId: p })).body.error).toBe("payment-not-paid");
    await api("payroll", u.mom, { action: "release", payrollId: p, payment: { method: "cash" } });
    expect((await me(uid)).body.me.salaries[0]).toMatchObject({ state: "paid", receipt: "not_confirmed", netPay: 60000 });
    expect((await me(uid, { action: "received", payrollId: p })).body).toMatchObject({ receipt: "received" });
    expect(docAt(`payrolls/${p}`)).toMatchObject({ status: "released", receiptStatus: "confirmed", receiptConfirmedVia: "staff-account" });
    const link = world.db.docs.get(`receiptLinks/${docAt(`payrolls/${p}`).receiptLinkHash}`);
    expect(link.usedAt).toBeTruthy();
    expect((await me(uid, { action: "received", payrollId: p })).body.alreadyConfirmed).toBe(true);
  });

  it("Not received flags Payment disputed and tells the Owner; a later confirmation resolves it", async () => {
    const id = await staff();
    const uid = await withLogin(id);
    const p = await paidSalary(id);
    await api("payroll", u.mom, { action: "release", payrollId: p, payment: { method: "gcash", reference: "GC-77" } });
    expect((await me(uid, { action: "notReceived", payrollId: p, note: "Walang dumating sa GCash" })).status).toBe(200);
    expect(docAt(`payrolls/${p}`)).toMatchObject({ status: "released", ownerPayment: "disputed", dispute: { state: "open", note: "Walang dumating sa GCash" } });
    expect(docAt(`members/${u.mom}/inbox/${notificationId("payroll.salary_disputed", `${p}-1`)}`)).toBeTruthy();
    expect((await me(uid)).body.me.salaries[0].receipt).toBe("not_received");
    await me(uid, { action: "received", payrollId: p });
    expect(docAt(`payrolls/${p}`)).toMatchObject({ ownerPayment: "paid", dispute: { state: "resolved" }, receiptStatus: "confirmed" });
  });
});
