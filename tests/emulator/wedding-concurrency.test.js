// Phase 16 Wedding concurrency on the REAL Firestore emulator (Admin SDK).
// After every race the stored totals equal a fresh calculation from the
// records:
//   - budgets/current spent / spentByCategory = the active Wedding Expenses;
//     upcoming = the Upcoming supplier payments; contracted / contractedPaid
//     = the suppliers' agreements and what's been paid on them;
//   - each supplier: paid = its active expenses (never above its agreed
//     amount), upcoming / upcomingCount / nextDue = its Upcoming payments;
//   - every Paid supplier payment has exactly ONE active expense, and no
//     payment ever has two;
//   - taskTotals and guestTotals = a recount of the tasks and guests.

import { beforeAll, describe, it, expect, vi } from "vitest";
import { taskTotalsDelta, guestContribution, guestCategoryDelta } from "../../shared/wedding.js";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });

const NOW = new Date("2026-10-16T04:00:00Z");
const WS = "bridal-expense";
let db, admin, FieldValue, wed, babyLib, exp, prov, tenantDb;
let run = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const fa = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin } = await fa.getAdmin());
  FieldValue = admin.firestore.FieldValue;
  wed = await import("../../netlify/functions/_lib/wedding.js");
  babyLib = await import("../../netlify/functions/_lib/baby.js");
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
  const id = `wed-${Date.now().toString(36)}-${run}`;
  await prov.createBusiness({ db, admin, name: `Wedding ${run}`, planId: "growth", workspaceTemplateId: WS, businessId: id });
  const tenant = tenantDb(db, id);
  const business = { id, timezone: "Asia/Manila" };
  const actor = (n = "Owner") => ({ uid: `${n}-${id}`, name: n, email: "" });
  const c = { db, tenant, FieldValue, business, workspace: WS, actor: actor(), now: NOW };
  // Phase 18.6: the total is the category budgets added up (₱500,000).
  const photo = (await babyLib.createCategory({ ...c, input: { name: "Photo / Video", budget: 8000000 } })).categoryId;
  const venue = (await babyLib.createCategory({ ...c, input: { name: "Venue", budget: 42000000 } })).categoryId;
  const supplierId = (await wed.createSupplier({ ...c, input: { name: "ABC Photo Studio", service: "photo_video", agreedAmount: 8000000 } })).supplierId;
  return { c, tenant, actor, photo, venue, supplierId };
}
const schedule = (w, amount, dueDate, supplierId = w.supplierId) => wed.createSupplierPayment({ ...w.c, input: { supplierId, description: `Payment ${dueDate}`, category: w.photo, amount, dueDate } }).then((r) => r.paymentId);
const pay = (w, paymentId, actor = w.c.actor, payment = { method: "cash" }) => wed.markSupplierPaymentPaid({ ...w.c, actor, paymentId, payment });

async function consistent(w) {
  const all = async (col) => (await w.tenant.collection(col).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const [bSnap, expenses, payments, suppliers, tasks, guests, tt, gt] = await Promise.all([w.tenant.doc("budgets", "current").get(), all("expenses"), all("supplierPayments"), all("weddingSuppliers"), all("weddingTasks"), all("guests"), w.tenant.doc("taskTotals", "current").get(), w.tenant.doc("guestTotals", "current").get()]);
  const b = bSnap.data() || {};
  const n = (v) => v ?? 0;
  const active = expenses.filter((e) => e.status === "active");
  const sum = (list, f = (x) => x.amount) => list.reduce((s, x) => s + f(x), 0);
  expect(n(b.spent), "spent").toBe(sum(active));
  const byCat = {};
  for (const e of active) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  for (const [k, v] of Object.entries(b.spentByCategory || {})) expect(v, `spentByCategory.${k}`).toBe(byCat[k] || 0);
  const upcoming = payments.filter((p) => p.status === "upcoming");
  expect(n(b.upcoming), "budget upcoming").toBe(sum(upcoming));
  expect(n(b.upcomingCount), "budget upcomingCount").toBe(upcoming.length);
  let contracted = 0;
  let contractedPaid = 0;
  for (const s of suppliers) {
    const paid = sum(active.filter((e) => e.supplierId === s.id));
    const up = upcoming.filter((p) => p.supplierId === s.id);
    expect(n(s.paid), `${s.name} paid`).toBe(paid);
    expect(n(s.upcoming), `${s.name} upcoming`).toBe(sum(up));
    expect(n(s.upcomingCount), `${s.name} upcomingCount`).toBe(up.length);
    expect(s.nextDue ?? null, `${s.name} nextDue`).toBe(up.map((p) => p.dueDate).sort()[0] ?? null);
    if (Number.isSafeInteger(s.agreedAmount)) {
      expect(paid, `${s.name} never paid beyond the agreement`).toBeLessThanOrEqual(s.agreedAmount);
      contracted += s.agreedAmount;
      contractedPaid += paid;
    }
  }
  expect(n(b.contracted), "contracted").toBe(contracted);
  expect(n(b.contractedPaid), "contractedPaid").toBe(contractedPaid);
  for (const p of payments) {
    const linked = active.filter((e) => e.supplierPaymentId === p.id);
    expect(linked.length, `expenses for ${p.id}`).toBe(p.status === "paid" ? 1 : 0);
  }
  const tCount = tasks.reduce((t, x) => {
    const d = taskTotalsDelta(null, x);
    for (const k of Object.keys(d)) t[k] = (t[k] || 0) + d[k];
    return t;
  }, {});
  for (const k of ["total", "open", "completed", "cancelled"]) expect(n(tt.data()?.[k]), `taskTotals.${k}`).toBe(tCount[k] || 0);
  const gCount = {};
  for (const g of guests) for (const [k, v] of Object.entries(guestContribution(g))) gCount[k] = (gCount[k] || 0) + v;
  for (const k of Object.keys(guestContribution(null))) expect(n(gt.data()?.[k]), `guestTotals.${k}`).toBe(gCount[k] || 0);
  // Phase 18.6: byCategory = a recount per category.
  const gByCat = {};
  for (const g of guests) for (const [c, d] of Object.entries(guestCategoryDelta(null, g))) for (const [k, v] of Object.entries(d)) (gByCat[c] ??= {})[k] = (gByCat[c][k] || 0) + v;
  for (const [c, stored] of Object.entries(gt.data()?.byCategory || {})) for (const [k, v] of Object.entries(stored)) expect(n(v), `guestTotals.byCategory.${c}.${k}`).toBe(gByCat[c]?.[k] || 0);
  for (const [c, d] of Object.entries(gByCat)) for (const [k, v] of Object.entries(d)) expect(n(gt.data()?.byCategory?.[c]?.[k]), `guestTotals.byCategory.${c}.${k}`).toBe(v);
  return { b, active, payments, suppliers };
}

describe("one supplier payment, one Wedding Expense", () => {
  it("Mark paid 10 times at once: exactly one expense; supplier paid / balance move once", async () => {
    const w = await world();
    const p = await schedule(w, 3000000, "2026-12-01");
    const r = await Promise.allSettled(Array.from({ length: 10 }, () => pay(w, p)));
    expectExplicit(r);
    expect(new Set(ok(r).map((x) => x.value.expenseId)).size).toBe(1);
    const { active, suppliers } = await consistent(w);
    expect(active).toHaveLength(1);
    expect(suppliers[0].paid).toBe(3000000);
  });

  it("two users mark the same payment paid: one expense", async () => {
    const w = await world();
    const p = await schedule(w, 2000000, "2026-11-01");
    const r = await Promise.allSettled([pay(w, p, w.actor("A")), pay(w, p, w.actor("B"), { method: "gcash" })]);
    expectExplicit(r);
    expect(new Set(ok(r).map((x) => x.value.expenseId)).size).toBe(1);
    expect((await consistent(w)).active).toHaveLength(1);
  });

  it("the agreed amount lowered while payments are being recorded: never paid beyond it, totals exact", async () => {
    const w = await world();
    const p1 = await schedule(w, 3000000, "2026-11-01");
    const p2 = await schedule(w, 3000000, "2026-12-01");
    const r = await Promise.allSettled([pay(w, p1), pay(w, p2), wed.updateSupplier({ ...w.c, supplierId: w.supplierId, changes: { agreedAmount: 6000000 } }), wed.updateSupplier({ ...w.c, supplierId: w.supplierId, changes: { agreedAmount: 5000000 } })]);
    expectExplicit(r, ["below-committed", "over-agreed"]);
    await consistent(w);
  });

  it("removing a paid expense racing a second Mark paid and a cancel of another payment: totals exact, at most one active expense per payment", async () => {
    const w = await world();
    const p1 = await schedule(w, 2000000, "2026-11-01");
    const p2 = await schedule(w, 1000000, "2026-11-15");
    const { expenseId } = await pay(w, p1);
    const r = await Promise.allSettled([exp.removeExpense({ ...w.c, expenseId, reason: "Wrong" }), pay(w, p1), wed.cancelSupplierPayment({ ...w.c, paymentId: p2 }), pay(w, p2)]);
    expectExplicit(r, ["not-upcoming"]);
    await consistent(w);
  });

  it("schedules, edits and cancels for one supplier at once: upcoming and next due stay exact", async () => {
    const w = await world();
    const ids = [];
    for (const d of ["2026-11-01", "2026-11-10", "2026-11-20"]) ids.push(await schedule(w, 500000, d));
    const r = await Promise.allSettled([schedule(w, 500000, "2026-10-25"), wed.cancelSupplierPayment({ ...w.c, paymentId: ids[0] }), wed.updateSupplierPayment({ ...w.c, paymentId: ids[2], changes: { dueDate: "2026-10-20", amount: 700000 } }), schedule(w, 400000, "2026-12-24"), pay(w, ids[1])]);
    expectExplicit(r, ["over-agreed"]);
    await consistent(w);
  });
});

describe("budget, expenses, tasks and guests under concurrency", () => {
  it("Suppliers Paid?: the same payment submitted 5 times at once (one idempotency key) records ONE expense", async () => {
    const w = await world();
    const input = { date: "2026-10-10", method: "gcash", category: w.photo, amount: 1000000, supplierId: w.supplierId };
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => exp.createExpense({ ...w.c, input, idempotencyKey: "same-dialog-key-00001" })));
    expectExplicit(r);
    expect(new Set(ok(r).map((x) => x.value.expenseId)).size).toBe(1);
    const { b } = await consistent(w);
    expect(b.spent).toBe(1000000);
  });

  it("expenses (direct and to a supplier) racing category budget changes: Spent / supplier paid exact; Total = Σ category budgets", async () => {
    const w = await world();
    const r = await Promise.allSettled([
      ...Array.from({ length: 8 }, (_, i) => exp.createExpense({ ...w.c, input: { date: "2026-10-10", method: "cash", category: i % 2 ? w.venue : w.photo, amount: 100000 + i, ...(i % 2 ? {} : { supplierId: w.supplierId }) } })),
      babyLib.updateCategory({ ...w.c, categoryId: w.venue, changes: { budget: 50000000 } }),
      babyLib.updateCategory({ ...w.c, categoryId: w.photo, changes: { budget: 10000000 } }),
    ]);
    expectExplicit(r, ["stale"]);
    const { b } = await consistent(w);
    expect(b.total).toBe(60000000);
    await expect(babyLib.setBudgetTotal({ ...w.c, total: 1 })).rejects.toMatchObject({ code: "budget-total-automatic" });
  });

  it("two users completing / reopening the same task, plus new tasks: taskTotals exact", async () => {
    const w = await world();
    const { taskId } = await wed.createTask({ ...w.c, input: { title: "Book the church", dueDate: "2026-11-01" } });
    const r = await Promise.allSettled([
      wed.setTaskStatus({ ...w.c, actor: w.actor("A"), taskId, status: "completed" }),
      wed.setTaskStatus({ ...w.c, actor: w.actor("B"), taskId, status: "completed" }),
      wed.setTaskStatus({ ...w.c, actor: w.actor("C"), taskId, status: "in_progress" }),
      ...Array.from({ length: 4 }, (_, i) => wed.createTask({ ...w.c, input: { title: `Task ${i}` } })),
    ]);
    expectExplicit(r);
    await consistent(w);
  });

  it("concurrent RSVP edits on the same and different guests: guestTotals never drift", async () => {
    const w = await world();
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await wed.createGuest({ ...w.c, input: { name: `Family ${i}`, side: "both", partySize: 4, category: i % 2 ? "friends" : "family" } })).guestId);
    const r = await Promise.allSettled([
      ...ids.flatMap((guestId, i) => [
        wed.setRsvp({ ...w.c, actor: w.actor("A"), guestId, rsvp: { status: "attending", confirmed: 1 + (i % 4) } }),
        wed.setRsvp({ ...w.c, actor: w.actor("B"), guestId, rsvp: i % 2 ? { status: "declined" } : { status: "attending", confirmed: 3 } }),
        wed.updateGuest({ ...w.c, actor: w.actor("C"), guestId, changes: { partySize: 5, invitationSent: "2026-10-01", ...(i === 1 ? { category: "work" } : {}) } }),
      ]),
      wed.createGuest({ ...w.c, input: { name: "Late addition", side: "bride", partySize: 2, category: "sponsors" } }),
      wed.removeGuest({ ...w.c, guestId: ids[3] }),
    ]);
    expectExplicit(r, ["not-found"]);
    await consistent(w);
  });
});
