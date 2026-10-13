// Owner-pilot fix (2026-10-11): one Household Staff record is the employee
// master (login, attendance, leave, advances, payroll, salary history), and
// a kasambahay's login is Household Staff access, never Manager / Admin.
// Everything below is enforced by the server (403), not by hidden buttons.

import { describe, it, expect, beforeEach } from "vitest";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createMeHandler } from "../../netlify/functions/me.js";
import { createMembersHandler } from "../../netlify/functions/members.js";
import { createActivateHandler } from "../../netlify/functions/activate.js";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { payrollEligibility } from "../../shared/payroll.js";

const NOW = new Date("2026-10-16T04:00:00Z"); // Oct 16, Manila
const H = "biz-home";
const H2 = "biz-home2";
let world, u, clock;

beforeEach(async () => {
  world = await buildWorld();
  clock = NOW;
  await createBusiness({ ...world, name: "Prado Household", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: H });
  await createBusiness({ ...world, name: "Other Household", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: H2 });
  u = {};
  for (const [key, role, biz] of [["carlo", "owner", H], ["admin", "manager", H], ["other", "owner", H2]]) {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@home.test`, name: key });
    await addMember({ ...world, businessId: biz, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  }
});

const deps = () => ({ getAdmin: async () => world, now: () => clock });
const HANDLERS = { staff: createHouseholdStaffHandler, attendance: createAttendanceHandler, payroll: createPayrollHandler, advances: createAdvancesHandler, members: createMembersHandler };
async function api(kind, uid, body, businessId = H) {
  const res = await HANDLERS[kind](deps())({ ...request({ uid, businessId, method: body ? "POST" : "GET" }), ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function me(uid, body = null, businessId = H) {
  const res = await createMeHandler(deps())({ ...request({ uid, businessId, method: body ? "POST" : "GET" }), ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const docAt = (p) => world.db.docs.get(`businesses/${H}/${p}`);
const paths = (prefix) => [...world.db.docs.keys()].filter((k) => k.startsWith(`businesses/${H}/${prefix}`));
async function staff(name, extra = {}) {
  const r = await api("staff", u.carlo, { action: "create", staff: { name, position: "Kasambahay", dailyWage: 60000, payCycle: "semi_monthly", ...extra } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.staffId;
}
async function activated(staffId) {
  const r = await api("staff", u.carlo, { action: "createLogin", staffId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const a = await createActivateHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "activate", token: r.body.activationToken, password: "kape-at-pandesal" }) });
  expect(a.statusCode).toBe(200);
  return r.body.uid;
}

describe("the kasambahay's login is Household Staff, never Manager / Admin", () => {
  it("Users page (household): offers Household Staff access for staff records without a login; the login is linked to exactly one record", async () => {
    const riza = await staff("Riza");
    const list = await api("members", u.carlo);
    expect(list.body).toMatchObject({ householdStaffAccess: true, staffWithoutLogin: [{ id: riza, name: "Riza" }] });
    const uid = await activated(riza);
    const after = (await api("members", u.carlo)).body;
    expect(after.staffWithoutLogin).toEqual([]);
    expect(after.members.find((m) => m.uid === uid)).toMatchObject({ role: "household_staff", roleLabel: "Household Staff", householdStaff: true });
    expect(docAt(`householdStaff/${riza}`).memberUid).toBe(uid);
    expect(docAt(`members/${uid}`).staffId).toBe(riza);
  });

  it("an account added by mistake as Manager / Admin becomes Household Staff in place (Manager access removed, audited)", async () => {
    const yanie = await ensureAuthUser({ auth: world.auth, email: "yanie@home.test", name: "Yanie" });
    await api("members", u.carlo, { action: "invite", member: { name: "Yanie", email: "yanie@home.test", role: "manager" } });
    expect(docAt(`members/${yanie.uid}`).permissions["payroll.manage"]).toBe(true);
    const rec = await staff("Yanie");
    // Only an Owner with household + users rights can do it.
    expect((await api("members", u.admin, { action: "linkStaff", uid: yanie.uid, staffId: rec })).status).toBe(403);
    const r = await api("members", u.carlo, { action: "linkStaff", uid: yanie.uid, staffId: rec });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const m = docAt(`members/${yanie.uid}`);
    expect(m).toMatchObject({ roleTemplate: "household_staff", staffId: rec });
    expect(Object.keys(m.permissions).filter((k) => m.permissions[k]).sort()).toEqual(["advances.self", "attendance.self", "payroll.self"]);
    expect(docAt(`householdStaff/${rec}`).memberUid).toBe(yanie.uid);
    const audit = paths("auditLog/").map((p) => world.db.docs.get(p)).find((a) => a.type === "member.updated" && a.member?.uid === yanie.uid);
    expect(audit).toMatchObject({ before: { roleTemplate: "manager" }, after: { roleTemplate: "household_staff" } });
    // Can't link twice, can't link the owner, can't link in a Distributor.
    expect((await api("members", u.carlo, { action: "linkStaff", uid: yanie.uid, staffId: rec })).status).toBe(409);
    expect((await api("members", u.carlo, { action: "linkStaff", uid: u.carlo, staffId: rec })).status).toBe(403);
    expect((await api("members", world.uids.ownera, { action: "linkStaff", uid: world.uids.staffa, staffId: rec }, "biz-a")).status).toBeGreaterThanOrEqual(400);
  });
});

describe("Household Staff can't do Owner actions (403 from the server)", () => {
  it("attendance / leave / advance / payroll / members / staff management / Super Luna / another tenant", async () => {
    const maria = await staff("Maria");
    const ana = await staff("Ana");
    const sUid = await activated(maria);
    // Her own requests (allowed).
    const att = await me(sUid, { action: "attendance", date: "2026-10-15", status: "present" });
    expect(att.status, JSON.stringify(att.body)).toBe(200);
    const leave = await me(sUid, { action: "attendance", date: "2026-10-14", status: "official_leave" });
    expect(leave.status).toBe(200);
    const adv = await me(sUid, { action: "advance", amount: 200000, reason: "Tuition" });
    expect(adv.status).toBe(200);
    const reqId = paths("attendanceRequests/").map((p) => p.split("/").at(-1))[0];
    const advId = paths("advances/").map((p) => p.split("/").at(-1))[0];
    const tries = [
      ["attendance", { action: "decide", requestId: reqId, decision: { decision: "approve" } }],
      ["attendance", { action: "set", staffId: maria, date: "2026-10-14", status: "present" }],
      ["attendance", { action: "set", staffId: ana, date: "2026-10-14", status: "absent" }],
      ["advances", { action: "decide", advanceId: advId, decision: { decision: "approve" }, approval: { amount: 500000 } }],
      ["advances", { action: "markPaid", advanceId: advId, release: { paidDate: "2026-10-16", method: "cash" } }],
      ["advances", { action: "update", advanceId: advId, changes: { amount: 999900 } }],
      ["advances", { action: "create", advance: { staffId: maria, date: "2026-10-16", amount: 100000 } }],
      ["payroll", { action: "prepareAll", asOf: "2026-10-16" }],
      ["payroll", { action: "prepare", staffId: maria, periodStart: "2026-10-01" }],
      ["staff", { action: "update", staffId: maria, changes: { dailyWage: 999900 } }],
      ["staff", { action: "create", staff: { name: "X", dailyWage: 1, payCycle: "weekly" } }],
      ["staff", { action: "createLogin", staffId: ana }],
      ["members", { action: "invite", member: { name: "X", role: "manager" } }],
      ["members", { action: "setRole", uid: u.admin, role: "manager" }],
    ];
    for (const [kind, body] of tries) expect((await api(kind, sUid, body)).status, `${kind} ${body.action}`).toBe(403);
    // Owner payroll for her: she can't release it or see another person's.
    const p = await api("payroll", u.carlo, { action: "prepare", staffId: maria, periodStart: "2026-10-01" });
    expect((await api("payroll", sUid, { action: "release", payrollId: p.body.payrollId, payment: { method: "cash" } })).status).toBe(403);
    const view = await me(sUid);
    expect(view.status).toBe(200);
    expect(JSON.stringify(view.body)).not.toContain("Ana");
    // Super Luna and another tenant: refused.
    const op = await createOperatorHandler(deps())({ ...request({ uid: sUid }), httpMethod: "POST", body: JSON.stringify({ action: "money" }) });
    expect(op.statusCode).toBe(403);
    expect((await me(sUid, null, H2)).status).toBe(403);
    expect((await api("attendance", sUid, { action: "set", staffId: maria, date: "2026-10-14", status: "present" }, H2)).status).toBe(403);
    // The Owner keeps every action.
    expect((await api("attendance", u.carlo, { action: "decide", requestId: reqId, decision: { decision: "approve" } })).status).toBe(200);
    expect((await api("advances", u.carlo, { action: "decide", advanceId: advId, decision: { decision: "approve" }, approval: { amount: 150000 } })).status).toBe(200);
    expect((await api("advances", u.carlo, { action: "markPaid", advanceId: advId, release: { paidDate: "2026-10-16", method: "cash" } })).status).toBe(200);
    expect(docAt(`advances/${advId}`)).toMatchObject({ staffId: maria, status: "paid" });
  });
});

describe("the staff record drives payroll: no second enrollment", () => {
  it("everyone employed in the period is prepared at once; a later start isn't included; Attendance / Advance / Payroll share the staff id", async () => {
    const maria = await staff("Maria", { startDate: "2026-06-01" });
    const late = await staff("Late Starter", { startDate: "2026-10-20" });
    await api("attendance", u.carlo, { action: "set", staffId: maria, date: "2026-10-02", status: "present" });
    const r = await api("payroll", u.carlo, { action: "prepareAll", asOf: "2026-10-05" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.prepared.map((x) => x.name)).toEqual(["Maria"]);
    expect(r.body.skipped).toEqual([{ staffId: late, name: "Late Starter", reason: "Starts 2026-10-20" }]);
    expect((await api("payroll", u.carlo, { action: "prepare", staffId: late, periodStart: "2026-10-01" })).body.error).toBe("not-eligible");
    const again = await api("payroll", u.carlo, { action: "prepareAll", asOf: "2026-10-05" });
    expect(again.body).toMatchObject({ prepared: [], existing: [{ name: "Maria" }] });
    const pid = r.body.prepared[0].payrollId;
    expect(docAt(`payrolls/${pid}`)).toMatchObject({ staffId: maria, present: 1 });
    expect(Object.values(world.db.docs).length).toBeGreaterThanOrEqual(0);
    const attendanceDocs = paths("attendance/").map((p) => world.db.docs.get(p));
    expect(attendanceDocs.every((a) => a.staffId === maria)).toBe(true);
    // The late starter's own period (Oct 16-31) includes them.
    const later = await api("payroll", u.carlo, { action: "prepareAll", asOf: "2026-10-16" });
    expect(later.body.prepared.map((x) => x.name).sort()).toEqual(["Late Starter", "Maria"]);
  });

  // Owner-pilot cleanup (2026-10-13): a deactivated helper gets no payroll at
  // all, not even the period they left in (pay them before deactivating).
  it("deactivating ends employment today: history kept, no payroll worked out any more; reactivating restores eligibility", async () => {
    const maria = await staff("Maria", { startDate: "2026-06-01" });
    await api("attendance", u.carlo, { action: "set", staffId: maria, date: "2026-10-15", status: "present" });
    expect((await api("staff", u.carlo, { action: "setStatus", staffId: maria, status: "inactive" })).body).toMatchObject({ status: "inactive", endDate: "2026-10-16" });
    expect(docAt(`attendance/${paths("attendance/")[0].split("/").at(-1)}`).staffId).toBe(maria);
    expect((await api("payroll", u.carlo, { action: "prepare", staffId: maria, periodStart: "2026-10-16" })).body.error).toBe("not-eligible");
    clock = new Date("2026-11-20T04:00:00Z");
    const nov = await api("payroll", u.carlo, { action: "prepareAll", asOf: "2026-11-01" });
    expect(nov.body.prepared).toEqual([]);
    expect((await api("payroll", u.carlo, { action: "prepare", staffId: maria, periodStart: "2026-11-01" })).body.error).toBe("not-eligible");
    expect((await api("staff", u.carlo, { action: "setStatus", staffId: maria, status: "active" })).body).toMatchObject({ status: "active", endDate: null });
    expect((await api("payroll", u.carlo, { action: "prepareAll", asOf: "2026-11-01" })).body.prepared.map((x) => x.name)).toEqual(["Maria"]);
  });

  it("eligibility rule", () => {
    const period = { start: "2026-10-01", end: "2026-10-15" };
    expect(payrollEligibility({ status: "active", startDate: "2026-10-20" }, period)).toMatchObject({ eligible: false });
    expect(payrollEligibility({ status: "active", startDate: "2026-10-15" }, period).eligible).toBe(true);
    expect(payrollEligibility({ status: "inactive", endDate: "2026-10-03" }, period).eligible).toBe(false);
    expect(payrollEligibility({ status: "inactive", endDate: "2026-09-30" }, period).eligible).toBe(false);
    expect(payrollEligibility({ status: "inactive" }, period).eligible).toBe(false);
  });
});

describe("attendance corrections", () => {
  it("the Owner corrects a day the employee sent only with a reason (kept with before / after); the employee can't overwrite it", async () => {
    const maria = await staff("Maria", { startDate: "2026-06-01" });
    const sUid = await activated(maria);
    await me(sUid, { action: "attendance", date: "2026-10-15", status: "present" });
    const reqId = paths("attendanceRequests/").map((p) => p.split("/").at(-1))[0];
    await api("attendance", u.carlo, { action: "decide", requestId: reqId, decision: { decision: "approve" } });
    const no = await api("attendance", u.carlo, { action: "set", staffId: maria, date: "2026-10-15", status: "official_leave" });
    expect(no.body.error).toBe("reason-required");
    const ok = await api("attendance", u.carlo, { action: "set", staffId: maria, date: "2026-10-15", status: "official_leave", reason: "She was on leave that day" });
    expect(ok.status).toBe(200);
    const line = docAt(paths("attendance/")[0].slice(`businesses/${H}/`.length));
    expect(line.status).toBe("official_leave");
    expect(line.history.at(-1)).toMatchObject({ from: "present", to: "official_leave", reason: "She was on leave that day" });
    expect(line.history.at(-1).label).toMatch(/Reason: She was on leave that day/);
    // The employee can only ask again (a request), never write the day.
    expect((await api("attendance", sUid, { action: "set", staffId: maria, date: "2026-10-15", status: "present" })).status).toBe(403);
  });
});
