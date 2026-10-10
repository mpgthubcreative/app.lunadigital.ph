// Phase 18.5 safe corrections: delete what was added by mistake, never
// history. A wedding task (no money attached), and a wedding supplier /
// baby provider / household staff member that nothing was ever recorded
// against. Anything with history is refused (409 ...-in-use: deactivate
// instead). Each delete keeps the totals right and leaves an audit
// snapshot; only members with the module's manage permission may delete.

import { describe, it, expect, beforeEach } from "vitest";
import { createBudgetHandler } from "../../netlify/functions/budget.js";
import { createExpensesHandler } from "../../netlify/functions/expenses.js";
import { createWeddingSuppliersHandler } from "../../netlify/functions/wedding-suppliers.js";
import { createSupplierPaymentsHandler } from "../../netlify/functions/supplier-payments.js";
import { createWeddingTasksHandler } from "../../netlify/functions/wedding-tasks.js";
import { createProvidersHandler } from "../../netlify/functions/providers.js";
import { createScheduleHandler } from "../../netlify/functions/schedule.js";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";

const NOW = new Date("2026-10-16T04:00:00Z");
const W = "biz-wed";
const B = "biz-baby";
const H = "biz-home";
let world;
let u;

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Wedding", planId: "growth", workspaceTemplateId: "bridal-expense", businessId: W });
  await createBusiness({ ...world, name: "Baby", planId: "growth", workspaceTemplateId: "baby-expense", businessId: B });
  await createBusiness({ ...world, name: "Home", planId: "growth", workspaceTemplateId: "household-payroll", businessId: H });
  u = {};
  const add = async (key, businessId, role) => {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@del.test`, name: key });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  };
  await add("wowner", W, "owner");
  await add("wstaff", W, "staff");
  await add("bowner", B, "owner");
  await add("bstaff", B, "staff");
  await add("howner", H, "owner");
});

const HANDLERS = { budget: createBudgetHandler, expenses: createExpensesHandler, suppliers: createWeddingSuppliersHandler, payments: createSupplierPaymentsHandler, tasks: createWeddingTasksHandler, providers: createProvidersHandler, schedule: createScheduleHandler, staff: createHouseholdStaffHandler, attendance: createAttendanceHandler, advances: createAdvancesHandler };
async function api(kind, uid, businessId, body) {
  const res = await HANDLERS[kind]({ getAdmin: async () => world, now: () => NOW })({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const doc = (p) => world.db.docs.get(p);
const audits = (bid, type) => [...world.db.docs.entries()].filter(([p, d]) => p.startsWith(`businesses/${bid}/auditLog/`) && d.type === type).map(([, d]) => d);

describe("wedding task: delete (no money attached)", () => {
  it("deletes the task, drops its contribution to the task totals, audits a snapshot", async () => {
    const t1 = (await api("tasks", u.wowner, W, { action: "create", task: { title: "Book the venue", dueDate: "2026-11-01" } })).body.taskId;
    await api("tasks", u.wowner, W, { action: "create", task: { title: "Order invitations" } });
    expect(doc(`businesses/${W}/taskTotals/current`)).toMatchObject({ total: 2, open: 2 });
    const r = await api("tasks", u.wowner, W, { action: "delete", taskId: t1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(doc(`businesses/${W}/weddingTasks/${t1}`)).toBeUndefined();
    expect(doc(`businesses/${W}/taskTotals/current`)).toMatchObject({ total: 1, open: 1 });
    expect(audits(W, "task.deleted")[0]).toMatchObject({ taskId: t1, snapshot: { title: "Book the venue", dueDate: "2026-11-01" }, actor: { uid: u.wowner } });
  });

  it("a completed task leaves the completed count; staff (no tasks.manage) can't delete; unknown id is 404", async () => {
    const t = (await api("tasks", u.wowner, W, { action: "create", task: { title: "Done thing" } })).body.taskId;
    await api("tasks", u.wowner, W, { action: "setStatus", taskId: t, status: "completed" });
    expect((await api("tasks", u.wstaff, W, { action: "delete", taskId: t })).status).toBe(403);
    expect((await api("tasks", u.wowner, W, { action: "delete", taskId: t })).status).toBe(200);
    expect(doc(`businesses/${W}/taskTotals/current`)).toMatchObject({ total: 0, open: 0, completed: 0 });
    expect((await api("tasks", u.wowner, W, { action: "delete", taskId: t })).status).toBe(404);
  });
});

describe("wedding supplier: delete only when nothing was recorded against it", () => {
  const supplier = async (agreedAmount = 9000000) => (await api("suppliers", u.wowner, W, { action: "create", supplier: { name: "ABC Photo", service: "photo_video", agreedAmount } })).body.supplierId;

  it("unused: deleted; its agreed amount leaves the contracted total; audited", async () => {
    await api("budget", u.wowner, W, { action: "setTotal", total: 50000000 });
    const s = await supplier();
    expect(doc(`businesses/${W}/budgets/current`).contracted).toBe(9000000);
    const r = await api("suppliers", u.wowner, W, { action: "delete", supplierId: s });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(doc(`businesses/${W}/weddingSuppliers/${s}`)).toBeUndefined();
    expect(doc(`businesses/${W}/budgets/current`).contracted).toBe(0);
    expect(audits(W, "supplier.deleted")[0]).toMatchObject({ supplierId: s, snapshot: { name: "ABC Photo", agreedAmount: 9000000 } });
  });

  it("with a scheduled payment (even one later cancelled) or an expense: refused (409), nothing changes", async () => {
    await api("budget", u.wowner, W, { action: "setTotal", total: 50000000 });
    const cats = (await api("budget", u.wowner, W, { action: "setupCategories" })).body.categoryIds;
    const s = await supplier();
    const p = await api("payments", u.wowner, W, { action: "create", payment: { supplierId: s, category: cats[0], amount: 1000000, dueDate: "2026-12-01", description: "Deposit" } });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    await api("payments", u.wowner, W, { action: "cancel", paymentId: p.body.paymentId });
    const r = await api("suppliers", u.wowner, W, { action: "delete", supplierId: s });
    expect(r).toMatchObject({ status: 409, body: { error: "supplier-in-use" } });
    expect(doc(`businesses/${W}/weddingSuppliers/${s}`)).toBeDefined();

    const s2 = await supplier(null);
    const e = await api("expenses", u.wowner, W, { action: "create", expense: { date: "2026-10-10", method: "cash", category: cats[0], amount: 100000, supplierId: s2 } });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    expect((await api("suppliers", u.wowner, W, { action: "delete", supplierId: s2 })).body.error).toBe("supplier-in-use");
    expect(audits(W, "supplier.deleted")).toHaveLength(0);
  });

  it("staff (no vendors.manage) can't delete", async () => {
    const s = await supplier();
    expect((await api("suppliers", u.wstaff, W, { action: "delete", supplierId: s })).status).toBe(403);
  });
});

describe("baby provider: delete only when unused", () => {
  const provider = async () => (await api("providers", u.bowner, B, { action: "create", provider: { name: "ABC Clinic", type: "medical" } })).body.providerId;

  it("unused: deleted and audited", async () => {
    const p = await provider();
    expect((await api("providers", u.bowner, B, { action: "delete", providerId: p })).status).toBe(200);
    expect(doc(`businesses/${B}/providers/${p}`)).toBeUndefined();
    expect(audits(B, "provider.deleted")[0]).toMatchObject({ providerId: p, snapshot: { name: "ABC Clinic" } });
  });

  it("used by an expense or a scheduled payment: refused (409); staff can't delete", async () => {
    await api("budget", u.bowner, B, { action: "setTotal", total: 15000000 });
    const cats = (await api("budget", u.bowner, B, { action: "setupCategories" })).body.categoryIds;
    const p1 = await provider();
    expect((await api("expenses", u.bowner, B, { action: "create", expense: { date: "2026-10-10", method: "cash", category: cats[0], amount: 100000, providerId: p1 } })).status).toBe(201);
    expect((await api("providers", u.bowner, B, { action: "delete", providerId: p1 })).body.error).toBe("provider-in-use");
    const p2 = await provider();
    expect((await api("schedule", u.bowner, B, { action: "create", payment: { description: "Check-up", category: cats[0], amount: 100000, dueDate: "2026-12-01", providerId: p2 } })).status).toBe(201);
    expect((await api("providers", u.bowner, B, { action: "delete", providerId: p2 })).status).toBe(409);
    const p3 = await provider();
    expect((await api("providers", u.bstaff, B, { action: "delete", providerId: p3 })).status).toBe(403);
  });
});

describe("household staff: delete only someone with no history", () => {
  const person = async (name = "Rosa") => (await api("staff", u.howner, H, { action: "create", staff: { name, dailyWage: 50000, payCycle: "semi_monthly" } })).body.staffId;

  it("never used: deleted and audited", async () => {
    const s = await person();
    const r = await api("staff", u.howner, H, { action: "delete", staffId: s });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(doc(`businesses/${H}/householdStaff/${s}`)).toBeUndefined();
    expect(audits(H, "staff.deleted")[0]).toMatchObject({ staffId: s, snapshot: { name: "Rosa", dailyWage: 50000 } });
  });

  it("with attendance or an advance: refused (409); the person stays", async () => {
    const a = await person("Ana");
    expect((await api("attendance", u.howner, H, { action: "set", staffId: a, date: "2026-10-15", status: "present" })).status).toBe(200);
    expect((await api("staff", u.howner, H, { action: "delete", staffId: a })).body.error).toBe("staff-in-use");
    const l = await person("Liza");
    expect((await api("advances", u.howner, H, { action: "create", advance: { staffId: l, date: "2026-10-05", amount: 50000 } })).status).toBe(201);
    expect((await api("staff", u.howner, H, { action: "delete", staffId: l })).status).toBe(409);
    expect(doc(`businesses/${H}/householdStaff/${l}`)).toBeDefined();
  });
});
