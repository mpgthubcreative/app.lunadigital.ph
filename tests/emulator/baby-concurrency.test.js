// Phase 15 Baby concurrency on the REAL Firestore emulator (Admin SDK).
// After every race the totals equal a fresh calculation from the records:
//   - budgets/current spent / expenseCount / spentByCategory = the active
//     Baby Expenses; upcoming / upcomingCount = the Upcoming payments;
//   - spendingMetrics (month) = the active expenses of that month;
//   - every Paid scheduled payment has exactly ONE expense, and no
//     scheduled payment ever has two.

import { beforeAll, describe, it, expect, vi } from "vitest";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });

const NOW = new Date("2026-10-16T04:00:00Z");
const W = "baby-expense";
let db, admin, FieldValue, baby, exp, prov, tenantDb;
let run = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const fa = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin } = await fa.getAdmin());
  FieldValue = admin.firestore.FieldValue;
  baby = await import("../../netlify/functions/_lib/baby.js");
  exp = await import("../../netlify/functions/_lib/expenses.js");
  prov = await import("../../netlify/functions/_lib/provisioning.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
  await prov.seedPlans({ db, admin, overwrite: true });
});

const CONTENDED = 10;
function expectExplicit(results, codes = []) {
  for (const r of results) if (r.status === "rejected") expect([CONTENDED, ...codes], String(r.reason && r.reason.message)).toContain(r.reason && r.reason.code);
}
const ok = (r) => r.filter((x) => x.status === "fulfilled");

async function world() {
  run += 1;
  const id = `baby-${Date.now().toString(36)}-${run}`;
  await prov.createBusiness({ db, admin, name: `Baby ${run}`, planId: "growth", workspaceTemplateId: W, businessId: id });
  const tenant = tenantDb(db, id);
  const business = { id, timezone: "Asia/Manila" };
  const actor = (n = "Owner") => ({ uid: `${n}-${id}`, name: n, email: "" });
  const c = { db, tenant, FieldValue, business, workspace: W, actor: actor(), now: NOW };
  await baby.setBudgetTotal({ ...c, total: 15000000 });
  const medical = (await baby.createCategory({ ...c, input: { name: "Medical", budget: 6000000 } })).categoryId;
  const nursery = (await baby.createCategory({ ...c, input: { name: "Nursery", budget: 4000000 } })).categoryId;
  return { c, tenant, actor, medical, nursery };
}
const add = (w, input, actor = w.c.actor) => exp.createExpense({ ...w.c, actor, input: { date: "2026-10-10", method: "cash", ...input } });

// The stored totals must equal a fresh sum of the records.
async function consistent(w) {
  const [b, expenses, scheduled, month] = await Promise.all([w.tenant.doc("budgets", "current").get(), w.tenant.collection("expenses").get(), w.tenant.collection("scheduledPayments").get(), w.tenant.doc("spendingMetrics", "2026-10").get()]);
  const budget = b.data();
  const active = expenses.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => e.status === "active");
  const sum = (list) => list.reduce((s, e) => s + e.amount, 0);
  expect(budget.spent ?? 0, "spent").toBe(sum(active));
  expect(budget.expenseCount ?? 0, "expenseCount").toBe(active.length);
  const byCat = {};
  for (const e of active) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  for (const [k, v] of Object.entries(budget.spentByCategory || {})) expect(v, `spentByCategory.${k}`).toBe(byCat[k] || 0);
  const upcoming = scheduled.docs.map((d) => d.data()).filter((s) => s.status === "upcoming");
  expect(budget.upcoming || 0, "upcoming").toBe(sum(upcoming));
  expect(budget.upcomingCount || 0, "upcomingCount").toBe(upcoming.length);
  const oct = active.filter((e) => e.date.startsWith("2026-10"));
  expect(month.exists ? month.data().spent : 0, "month spent").toBe(sum(oct));
  for (const s of scheduled.docs) {
    const linked = active.filter((e) => e.scheduleId === s.id);
    expect(linked.length, `expenses for ${s.id}`).toBe(s.data().status === "paid" ? 1 : 0);
  }
  return { budget, active };
}

describe("expenses racing each other", () => {
  it("20 expenses added at once: Spent = their sum, nothing lost", async () => {
    const w = await world();
    const r = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => add(w, { category: i % 2 ? w.medical : w.nursery, amount: 10000 + i })));
    expectExplicit(r);
    const { active } = await consistent(w);
    expect(active.length).toBe(ok(r).length);
    expect(active.length).toBe(20);
  });

  it("two users editing the same expense: one revision wins, the other is told it's stale; totals match", async () => {
    const w = await world();
    const { expenseId } = await add(w, { category: w.nursery, amount: 1500000 });
    const r = await Promise.allSettled([
      exp.updateExpense({ ...w.c, actor: w.actor("A"), expenseId, expectedRevision: 1, changes: { amount: 1200000 } }),
      exp.updateExpense({ ...w.c, actor: w.actor("B"), expenseId, expectedRevision: 1, changes: { amount: 1300000, category: w.medical } }),
    ]);
    expectExplicit(r, ["stale-expense"]);
    expect(ok(r).length).toBe(1);
    await consistent(w);
  });

  it("expense edits and removals while the budget total changes: Remaining always = Budget − Spent", async () => {
    const w = await world();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await add(w, { category: w.medical, amount: 100000 })).expenseId);
    const r = await Promise.allSettled([
      ...ids.slice(0, 3).map((expenseId, i) => exp.updateExpense({ ...w.c, expenseId, changes: { amount: 200000 + i } })),
      ...ids.slice(3).map((expenseId) => exp.removeExpense({ ...w.c, expenseId, reason: "Duplicate" })),
      baby.setBudgetTotal({ ...w.c, total: 18000000 }),
      baby.setBudgetTotal({ ...w.c, total: 20000000 }),
    ]);
    expectExplicit(r, ["stale"]);
    const { budget } = await consistent(w);
    expect([18000000, 20000000]).toContain(budget.total);
  });
});

describe("Payment Schedule: one payment, one expense", () => {
  async function deposit(w) {
    return (await baby.createScheduledPayment({ ...w.c, input: { description: "Hospital deposit", category: w.medical, amount: 2000000, dueDate: "2026-12-15" } })).scheduleId;
  }

  it("Mark paid 10 times at once (double-clicks, retries): exactly one expense, Spent +₱20,000 once", async () => {
    const w = await world();
    const scheduleId = await deposit(w);
    const r = await Promise.allSettled(Array.from({ length: 10 }, () => baby.markScheduledPaymentPaid({ ...w.c, scheduleId, payment: { method: "cash" } })));
    expectExplicit(r);
    const ids = new Set(ok(r).map((x) => x.value.expenseId));
    expect(ids.size).toBe(1);
    const { budget, active } = await consistent(w);
    expect(active.length).toBe(1);
    expect(budget.spent).toBe(2000000);
    expect(budget.upcoming).toBe(0);
  });

  it("two users mark the same payment paid: one expense; the other is told it's already paid", async () => {
    const w = await world();
    const scheduleId = await deposit(w);
    const r = await Promise.allSettled([baby.markScheduledPaymentPaid({ ...w.c, actor: w.actor("A"), scheduleId, payment: { method: "cash" } }), baby.markScheduledPaymentPaid({ ...w.c, actor: w.actor("B"), scheduleId, payment: { method: "gcash" } })]);
    expectExplicit(r);
    const values = ok(r).map((x) => x.value);
    expect(new Set(values.map((v) => v.expenseId)).size).toBe(1);
    expect((await consistent(w)).active.length).toBe(1);
  });

  it("Mark paid racing Cancel: exactly one wins; never a cancelled payment with an expense", async () => {
    const w = await world();
    const scheduleId = await deposit(w);
    const r = await Promise.allSettled([baby.markScheduledPaymentPaid({ ...w.c, scheduleId, payment: { method: "cash" } }), baby.cancelScheduledPayment({ ...w.c, scheduleId })]);
    expectExplicit(r, ["not-upcoming"]);
    await consistent(w);
  });

  it("removing the paid expense racing a second Mark paid: still at most one active expense per payment", async () => {
    const w = await world();
    const scheduleId = await deposit(w);
    const { expenseId } = await baby.markScheduledPaymentPaid({ ...w.c, scheduleId, payment: { method: "cash" } });
    const r = await Promise.allSettled([exp.removeExpense({ ...w.c, expenseId, reason: "Wrong" }), baby.markScheduledPaymentPaid({ ...w.c, scheduleId, payment: { method: "cash" } }), baby.markScheduledPaymentPaid({ ...w.c, scheduleId, payment: { method: "cash" } })]);
    expectExplicit(r);
    await consistent(w);
  });
});

describe("reference data changing under a write", () => {
  it("provider deactivated while expenses are recorded against it: each is either recorded (with the name) or refused", async () => {
    const w = await world();
    const { providerId } = await baby.createProvider({ ...w.c, input: { name: "ABC Clinic", type: "medical" } });
    const r = await Promise.allSettled([...Array.from({ length: 5 }, () => add(w, { category: w.medical, amount: 50000, providerId })), baby.setProviderStatus({ ...w.c, providerId, status: "inactive" })]);
    expectExplicit(r, ["invalid-provider"]);
    const { active } = await consistent(w);
    for (const e of active) expect(e.payee).toBe("ABC Clinic");
  });

  it("a category deleted while an expense starts using it: never an orphaned expense", async () => {
    const w = await world();
    const { categoryId } = await baby.createCategory({ ...w.c, input: { name: "Gear" } });
    const r = await Promise.allSettled([add(w, { category: categoryId, amount: 70000 }), baby.deleteCategory({ ...w.c, categoryId })]);
    expectExplicit(r, ["invalid-category", "category-in-use"]);
    const cat = await w.tenant.doc("expenseCategories", categoryId).get();
    const { active } = await consistent(w);
    if (active.some((e) => e.category === categoryId)) expect(cat.exists).toBe(true);
    expect(ok(r).length).toBe(1);
  });
});
