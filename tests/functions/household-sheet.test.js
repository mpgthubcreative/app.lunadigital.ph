// Owner-pilot polish (after Phase 18.6): the staff member's pay-period
// attendance sheet. Several days in ONE submission (all or nothing), only
// their own record, only inside their employment, never overwriting what the
// Owner approved; the Owner approves a whole period at once and payroll still
// counts each day.

import { describe, it, expect, beforeEach } from "vitest";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createMeHandler } from "../../netlify/functions/me.js";
import { createActivateHandler } from "../../netlify/functions/activate.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";

const NOW = new Date("2026-10-16T04:00:00Z"); // Oct 16, 12:00 Manila
const H = "biz-home";
let world;
let u;

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Santos Household", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: H });
  u = {};
  for (const [key, role] of [["mom", "owner"], ["dad", "manager"]]) {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@home.test`, name: key });
    await addMember({ ...world, businessId: H, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  }
});

const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const HANDLERS = { staff: createHouseholdStaffHandler, attendance: createAttendanceHandler, payroll: createPayrollHandler };
async function api(kind, uid, body) {
  const res = await HANDLERS[kind](deps())({ ...request({ uid, businessId: H, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function me(uid, body = null, period = null) {
  const res = await createMeHandler(deps())({ ...request({ uid, businessId: H, method: body ? "POST" : "GET" }), ...(body ? { body: JSON.stringify(body) } : {}), ...(period ? { queryStringParameters: { period } } : {}) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const docAt = (p) => world.db.docs.get(`businesses/${H}/${p}`);
const inbox = (uid) => [...world.db.docs.keys()].filter((k) => k.startsWith(`businesses/${H}/members/${uid}/inbox/`)).length;

async function staff(name = "Maria Santos", extra = {}) {
  const r = await api("staff", u.mom, { action: "create", staff: { name, position: "Kasambahay", dailyWage: 60000, payCycle: "semi_monthly", ...extra } });
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
const days = (list) => ({ action: "attendanceDays", days: list.map(([date, status]) => ({ date, status })) });
const OCT = (n) => `2026-10-${String(n).padStart(2, "0")}`;

describe("staff attendance sheet: several days in one submission", () => {
  it("submits a period's days at once: each day is its own pending request; attendance unchanged; ONE notification", async () => {
    const id = await staff();
    const uid = await withLogin(id);
    const before = inbox(u.mom);
    const list = [[OCT(6), "present"], [OCT(7), "present"], [OCT(8), "rest_day"], [OCT(9), "present"], [OCT(10), "official_leave"], [OCT(15), "absent"]];
    const r = await me(uid, days(list));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ sent: 6, unchanged: 0 });
    for (const [date, status] of list) {
      expect(docAt(`attendanceRequests/${id}_${date}`)).toMatchObject({ staffId: id, date, status, state: "pending", revision: 1 });
      expect(docAt(`attendance/${id}_${date}`)).toBeUndefined();
    }
    expect(inbox(u.mom) - before).toBe(1);
  });

  it("the sheet shows any allowed pay period with prev / next; days outside employment or too old are locked", async () => {
    const id = await staff("Maria Santos", { startDate: OCT(5) });
    const uid = await withLogin(id);
    await me(uid, days([[OCT(6), "present"]]));
    const cur = (await me(uid)).body.me.sheet;
    expect(cur).toMatchObject({ start: OCT(16), end: OCT(31), current: true, prev: OCT(1) });
    const prev = (await me(uid, null, OCT(1))).body.me.sheet;
    expect(prev).toMatchObject({ start: OCT(1), end: OCT(15), current: false, prev: null, next: OCT(16) });
    expect(prev.days.find((d) => d.date === OCT(4)).lock).toBe("Before your start date");
    expect(prev.days.find((d) => d.date === OCT(6))).toMatchObject({ pending: "present", lock: null });
    // The salary card still shows the CURRENT period.
    expect((await me(uid, null, OCT(1))).body.me.period.start).toBe(OCT(16));
    expect((await me(uid, null, "2026-10-03")).status).toBe(400); // not a period start
    expect((await me(uid, null, "2026-09-16")).status).toBe(400); // before the start date
  });

  it("dates outside employment are refused, and then NOTHING is sent (all or nothing)", async () => {
    const id = await staff("Maria Santos", { startDate: OCT(10) });
    const uid = await withLogin(id);
    const r = await me(uid, days([[OCT(8), "present"], [OCT(12), "present"]]));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("days-not-allowed");
    expect(r.body.message).toMatch(/2026-10-08: Before your start date/);
    expect(docAt(`attendanceRequests/${id}_${OCT(12)}`)).toBeUndefined();
    // After the last day.
    expect((await api("staff", u.mom, { action: "update", staffId: id, changes: { endDate: OCT(14) } })).status).toBe(200);
    expect((await me(uid, days([[OCT(15), "rest_day"]]))).body.message).toMatch(/After your last day/);
    // Present can't be sent for a future day; too old days are refused.
    expect((await me(uid, days([[OCT(17), "present"]]))).body.error).toBe("invalid-date");
  });

  it("only their own record: no staffId anywhere in the request; the Owner's tools stay 403", async () => {
    const id = await staff();
    const other = await staff("Lito Cruz");
    const uid = await withLogin(id);
    expect((await me(uid, { ...days([[OCT(14), "present"]]), staffId: other })).status).toBe(400);
    expect((await me(uid, { action: "attendanceDays", days: [{ date: OCT(14), status: "present", staffId: other }] })).status).toBe(400);
    expect((await api("attendance", uid, { action: "decideMany", requestIds: [`${other}_${OCT(14)}`], decision: { decision: "approve" } })).status).toBe(403);
    await me(uid, days([[OCT(14), "present"]]));
    expect(docAt(`attendanceRequests/${other}_${OCT(14)}`)).toBeUndefined();
    expect(docAt(`attendanceRequests/${id}_${OCT(14)}`)).toMatchObject({ staffId: id });
    // Duplicate dates and too many days are refused.
    expect((await me(uid, days([[OCT(14), "present"], [OCT(14), "absent"]]))).status).toBe(400);
  });

  it("an Owner-approved day is never silently overwritten (a different status is refused; the same one is unchanged)", async () => {
    const id = await staff();
    const uid = await withLogin(id);
    await api("attendance", u.mom, { action: "set", staffId: id, date: OCT(14), status: "present" });
    const r = await me(uid, days([[OCT(13), "present"], [OCT(14), "absent"]]));
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/2026-10-14: Approved by your employer/);
    expect(docAt(`attendanceRequests/${id}_${OCT(13)}`)).toBeUndefined();
    expect(docAt(`attendance/${id}_${OCT(14)}`)).toMatchObject({ status: "present" });
    expect((await me(uid, days([[OCT(13), "present"], [OCT(14), "present"]]))).body).toMatchObject({ sent: 1, unchanged: 1 });
    expect((await me(uid, null, OCT(1))).body.me.sheet.days.find((d) => d.date === OCT(14))).toMatchObject({ status: "present", lock: "Approved by your employer" });
  });

  it("pending days can be changed until approved; rejected days can be sent again", async () => {
    const id = await staff();
    const uid = await withLogin(id);
    await me(uid, days([[OCT(6), "present"], [OCT(7), "present"]]));
    expect((await api("attendance", u.mom, { action: "decide", requestId: `${id}_${OCT(7)}`, decision: { decision: "reject", note: "Day off" } })).status).toBe(200);
    expect((await me(uid, null, OCT(1))).body.me.sheet.days.find((d) => d.date === OCT(7))).toMatchObject({ rejected: "present", pending: null, lock: null });
    const r = await me(uid, days([[OCT(6), "rest_day"], [OCT(7), "rest_day"]]));
    expect(r.body).toMatchObject({ sent: 2 });
    expect(docAt(`attendanceRequests/${id}_${OCT(6)}`)).toMatchObject({ status: "rest_day", state: "pending", revision: 2 });
    expect(docAt(`attendanceRequests/${id}_${OCT(6)}`).history.at(-1).label).toMatch(/replaces Present/);
    expect(docAt(`attendanceRequests/${id}_${OCT(7)}`)).toMatchObject({ status: "rest_day", state: "pending", decidedBy: null });
    expect(docAt(`attendanceRequests/${id}_${OCT(7)}`).history.at(-1).label).toMatch(/sent again/);
  });

  it("retrying the same submission changes nothing: no duplicate requests, history or notifications", async () => {
    const id = await staff();
    const uid = await withLogin(id);
    const body = days([[OCT(8), "present"], [OCT(9), "rest_day"]]);
    await me(uid, body);
    const hist = docAt(`attendanceRequests/${id}_${OCT(8)}`).history.length;
    const notes = inbox(u.mom);
    expect((await me(uid, body)).body).toMatchObject({ sent: 0, unchanged: 2 });
    expect(docAt(`attendanceRequests/${id}_${OCT(8)}`)).toMatchObject({ revision: 1 });
    expect(docAt(`attendanceRequests/${id}_${OCT(8)}`).history.length).toBe(hist);
    expect(inbox(u.mom)).toBe(notes);
  });

  it("the Owner approves the whole period at once; each day is marked with its history; payroll counts every day; a paid period locks", async () => {
    const id = await staff();
    const uid = await withLogin(id);
    const list = [[OCT(2), "present"], [OCT(3), "present"], [OCT(4), "rest_day"], [OCT(5), "official_leave"], [OCT(6), "present"], [OCT(7), "unpaid_leave"]];
    await me(uid, days(list));
    const ids = list.map(([d]) => `${id}_${d}`);
    const r = await api("attendance", u.mom, { action: "decideMany", requestIds: ids, decision: { decision: "approve" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ decided: ids, failed: [] });
    for (const [date, status] of list) {
      expect(docAt(`attendance/${id}_${date}`)).toMatchObject({ status });
      expect(docAt(`attendanceRequests/${id}_${date}`)).toMatchObject({ state: "approved", decidedBy: { uid: u.mom } });
    }
    // Deciding again reports each day, nothing changes.
    expect((await api("attendance", u.mom, { action: "decideMany", requestIds: ids.slice(0, 2), decision: { decision: "reject" } })).body.failed).toHaveLength(2);
    const p = await api("payroll", u.mom, { action: "prepare", staffId: id, periodStart: OCT(1) });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    // 3 present + 1 paid leave = 4 paid days at ₱600.
    expect(docAt(`payrolls/${p.body.payrollId}`)).toMatchObject({ present: 3, officialLeave: 1, restDay: 1, unpaidLeave: 1, basePay: 240000 });
    expect((await api("payroll", u.mom, { action: "release", payrollId: p.body.payrollId, payment: { method: "cash" } })).status).toBe(200);
    expect((await me(uid, days([[OCT(9), "present"]]))).body.message).toMatch(/In a paid salary/);
    expect((await me(uid, null, OCT(1))).body.me.sheet).toMatchObject({ paid: true });
  });
});
