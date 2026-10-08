// Expense metrics under concurrency on the REAL Firestore emulator (Admin
// SDK). However creates, edits and removals interleave, each day's and
// month's operatingExpenses must equal the sum of the active expenses in
// it, and every failure must be explicit (domain refusal or contention).

import { beforeAll, describe, it, expect, vi } from "vitest";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });

const actor = { uid: "conc-exp", name: "Concurrency", email: "" };
const NOW = new Date("2026-10-08T06:00:00Z");
let db, FieldValue, ex, tenantDb;
let run = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const admin = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin: { firestore: { FieldValue } } } = await admin.getAdmin());
  ex = await import("../../netlify/functions/_lib/expenses.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
});

const CONTENDED = 10;
const settle = (p) => Promise.allSettled(p);
const ok = (r) => r.filter((x) => x.status === "fulfilled");
function expectExplicit(results, codes = []) {
  for (const r of results) if (r.status === "rejected") expect([CONTENDED, ...codes], String(r.reason && r.reason.message)).toContain(r.reason && r.reason.code);
}

function world() {
  run += 1;
  const id = `expc-${Date.now().toString(36)}-${run}`;
  return { tenant: tenantDb(db, id), business: { id, timezone: "Asia/Manila" } };
}
const add = (w, date, amount) => ex.createExpense({ db, tenant: w.tenant, FieldValue, business: w.business, actor, now: NOW, input: { date, category: "misc", amount, method: "cash" } });
const edit = (w, expenseId, changes, expectedRevision = null) => ex.updateExpense({ db, tenant: w.tenant, FieldValue, business: w.business, actor, now: NOW, expenseId, changes, expectedRevision });
const remove = (w, expenseId) => ex.removeExpense({ db, tenant: w.tenant, FieldValue, business: w.business, actor, expenseId, reason: "race test" });

async function expectMetricsExact(w) {
  const active = (await w.tenant.collection("expenses").where("status", "==", "active").get()).docs.map((d) => d.data());
  const metrics = (await w.tenant.collection("financialMetrics").get()).docs;
  for (const d of metrics) {
    const id = d.id;
    if (id === "current") continue;
    const expected = active.filter((e) => (id.length === 10 ? e.date === id : e.month === id)).reduce((s, e) => s + e.amount, 0);
    expect(d.data().operatingExpenses ?? 0, id).toBe(expected);
  }
  return active;
}

describe("expense races", () => {
  it("10 expenses recorded on the same day at once: all counted, exactly", async () => {
    const w = world();
    const results = await settle(Array.from({ length: 10 }, (_, i) => add(w, "2026-10-08", 1000 * (i + 1))));
    expectExplicit(results);
    const active = await expectMetricsExact(w);
    expect(active).toHaveLength(ok(results).length);
  });

  it("two users editing the same expense: both apply in some order, or the second sees a stale revision", async () => {
    const w = world();
    const { expenseId } = await add(w, "2026-10-08", 200000);
    const results = await settle([edit(w, expenseId, { amount: 150000 }, 1), edit(w, expenseId, { amount: 120000 }, 1)]);
    expectExplicit(results, ["stale-expense"]);
    expect(ok(results)).toHaveLength(1);
    await expectMetricsExact(w);
  });

  it("edit vs remove: either the removal wins (nothing counts) or the edit lands first and then it's removed", async () => {
    const w = world();
    const { expenseId } = await add(w, "2026-10-08", 200000);
    const results = await settle([edit(w, expenseId, { amount: 50000, date: "2026-09-30" }), remove(w, expenseId)]);
    expectExplicit(results, ["removed"]);
    const active = await expectMetricsExact(w);
    expect(active).toHaveLength(0);
  });

  it("a date correction moving an expense into a day another expense is updating", async () => {
    const w = world();
    const a = await add(w, "2026-10-01", 100000);
    const b = await add(w, "2026-10-08", 30000);
    const results = await settle([edit(w, a.expenseId, { date: "2026-10-08" }), edit(w, b.expenseId, { amount: 45000 }), add(w, "2026-10-08", 5000), add(w, "2026-09-30", 7000)]);
    expectExplicit(results);
    await expectMetricsExact(w);
  });

  it("many mixed operations on a few expenses: day and month totals stay exact", async () => {
    const w = world();
    const ids = [];
    for (const [d, amt] of [["2026-10-08", 1000], ["2026-10-07", 2000], ["2026-09-15", 3000]]) ids.push((await add(w, d, amt)).expenseId);
    const results = await settle([
      edit(w, ids[0], { amount: 1500 }),
      edit(w, ids[0], { date: "2026-10-01" }),
      edit(w, ids[1], { date: "2026-09-15", amount: 2500 }),
      remove(w, ids[2]),
      edit(w, ids[2], { amount: 9999 }),
      add(w, "2026-10-08", 4000),
    ]);
    expectExplicit(results, ["removed"]);
    await expectMetricsExact(w);
  });
});
