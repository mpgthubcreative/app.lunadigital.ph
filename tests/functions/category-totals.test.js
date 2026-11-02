// Category totals survive edits that don't move money (2026-11-02 fix).
// An edit with no category change (notes, payee, Paid by, a bill's
// description) used to write an EMPTY increments map with merge, and real
// Firestore treats an empty map as a value: spentByCategory /
// upcomingByCategory were wiped (Total spent stayed right; the per-category
// split didn't). Same-day category moves now reach the day / month
// byCategory too. Household, Baby and Bridal.

import { describe, it, expect, beforeEach } from "vitest";
import { createBudgetHandler } from "../../netlify/functions/budget.js";
import { createExpensesHandler } from "../../netlify/functions/expenses.js";
import { createScheduleHandler } from "../../netlify/functions/schedule.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { withRequestKey } from "../helpers/request-keys.js";

let world;
let uid;
const clock = new Date("2026-10-13T04:00:00Z");
const deps = () => ({ getAdmin: async () => world, now: () => clock });
const HANDLERS = { budget: createBudgetHandler, expenses: createExpensesHandler, schedule: createScheduleHandler };
let B;
async function api(kind, body) {
  const res = await HANDLERS[kind](deps())({ ...request({ uid, businessId: B, method: "POST" }), body: JSON.stringify(withRequestKey(kind, body)) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const docAt = (p) => world.db.docs.get(`businesses/${B}/${p}`);
async function workspace(planId, workspaceTemplateId) {
  world = await buildWorld();
  B = `biz-${workspaceTemplateId}`;
  await createBusiness({ ...world, name: "Totals", planId, workspaceTemplateId, businessId: B });
  const x = await ensureAuthUser({ auth: world.auth, email: `owner@${workspaceTemplateId}.test`, name: "Owner" });
  await addMember({ ...world, businessId: B, uid: x.uid, email: x.email, name: "Owner", roleTemplate: "owner", isAccountOwner: true });
  uid = x.uid;
}
const category = async (name) => ok(await api("budget", { action: "createCategory", category: { name, budget: null } }), 201).categoryId;
const spend = async (cat, amount, extra = {}) => ok(await api("expenses", { action: "create", expense: { date: "2026-10-05", category: cat, amount, method: "cash", ...extra } }), 201).expenseId;
const edit = async (id, changes) => ok(await api("expenses", { action: "update", expenseId: id, expectedRevision: docAt(`expenses/${id}`).revision, changes }));

describe.each([
  ["household-plus", "household-payroll"],
  ["baby-basic", "baby-expense"],
  ["bridal-basic", "bridal-expense"],
])("%s (%s): edits that move no money keep the category totals", (planId, template) => {
  beforeEach(() => workspace(planId, template));

  it("notes / payee edits keep spentByCategory and the month's byCategory", async () => {
    const a = await category("Groceries");
    const b = await category("Utilities");
    const id = await spend(a, 100000);
    await spend(b, 50000);
    await edit(id, { notes: "Weekly" });
    await edit(id, { payee: "SM Supermarket" });
    expect(docAt("budgets/current").spentByCategory).toEqual({ [a]: 100000, [b]: 50000 });
    expect(docAt("budgets/current").spent).toBe(150000);
    expect(docAt("spendingMetrics/2026-10").byCategory).toEqual({ [a]: 100000, [b]: 50000 });
  });

  it("a same-day category move (same amount) moves the money in the budget AND the day / month split", async () => {
    const a = await category("Groceries");
    const b = await category("Utilities");
    const id = await spend(a, 100000);
    await edit(id, { category: b });
    expect(docAt("budgets/current").spentByCategory).toEqual({ [a]: 0, [b]: 100000 });
    expect(docAt("spendingMetrics/2026-10-05").byCategory).toEqual({ [a]: 0, [b]: 100000 });
    expect(docAt("spendingMetrics/2026-10").byCategory).toEqual({ [a]: 0, [b]: 100000 });
  });
});

describe("Household: Paid by and bill edits keep the totals", () => {
  beforeEach(() => workspace("household-plus", "household-payroll"));

  it("changing only Paid by keeps spentByCategory", async () => {
    const a = await category("Groceries");
    const id = await spend(a, 100000, { paidBy: [{ name: "Mom", amount: 100000 }] });
    await edit(id, { paidBy: [{ name: "Dad", amount: 100000 }] });
    expect(docAt("budgets/current").spentByCategory).toEqual({ [a]: 100000 });
    expect(docAt("budgets/current").spentByPayer).toEqual({ mom: 0, dad: 100000 });
  });

  it("editing a bill's description keeps upcomingByCategory", async () => {
    const u = await category("Utilities");
    const sid = ok(await api("schedule", { action: "create", payment: { description: "Meralco", category: u, amount: 450000, dueDate: "2026-10-20" } }), 201).scheduleId;
    expect(docAt("budgets/current").upcomingByCategory).toEqual({ [u]: 450000 });
    ok(await api("schedule", { action: "update", scheduleId: sid, expectedRevision: docAt(`scheduledPayments/${sid}`).revision, changes: { description: "Meralco (house)" } }));
    expect(docAt("budgets/current").upcomingByCategory).toEqual({ [u]: 450000 });
    expect(docAt("budgets/current").upcoming).toBe(450000);
  });
});

describe("repair: recomputeCategoryTotals (scripts/recompute-category-totals.js)", () => {
  beforeEach(() => workspace("household-plus", "household-payroll"));

  it("dry run reports; apply rebuilds the split from active expenses only (removed ones don't count); Total spent untouched", async () => {
    const { recomputeCategoryTotals } = await import("../../netlify/functions/_lib/category-totals.js");
    const { tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js");
    const FieldValue = world.admin.firestore.FieldValue;
    const tenant = tenantDb(world.db, B);
    const a = await category("Groceries");
    const b = await category("Utilities");
    await spend(a, 100000);
    await spend(b, 50000);
    const gone = await spend(b, 7000);
    ok(await api("expenses", { action: "remove", expenseId: gone, reason: "Entered twice" }));
    const wiped = { ...docAt("budgets/current"), spentByCategory: {} };
    world.db.docs.set(`businesses/${B}/budgets/current`, wiped); // the damaged state
    const dry = await recomputeCategoryTotals({ db: world.db, tenant, FieldValue, apply: false, actor: { uid: "t", name: "t" } });
    expect(dry).toMatchObject({ changed: true, after: { [a]: 100000, [b]: 50000 } });
    expect(docAt("budgets/current").spentByCategory).toEqual({});
    const done = await recomputeCategoryTotals({ db: world.db, tenant, FieldValue, apply: true, actor: { uid: "t", name: "t" } });
    expect(done.applied).toBe(true);
    expect(docAt("budgets/current").spentByCategory).toEqual({ [a]: 100000, [b]: 50000 });
    expect(docAt("budgets/current").spent).toBe(150000);
    expect((await recomputeCategoryTotals({ db: world.db, tenant, FieldValue, apply: true, actor: { uid: "t", name: "t" } })).changed).toBe(false);
  });
});
