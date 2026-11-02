// Category totals on the REAL Firestore emulator (2026-11-02). Real
// Firestore treats an empty map written with merge as a value (it replaces
// the stored map); the unit tests' fake now does the same, and this checks
// it against the real thing: an expense edit that moves no money (notes,
// Paid by) keeps budgets/current.spentByCategory, and the repair rebuilds a
// wiped split from the active expenses.

import { beforeAll, describe, it, expect, vi } from "vitest";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });

const actor = { uid: "cat-totals", name: "Category totals", email: "" };
const NOW = new Date("2026-10-08T06:00:00Z");
const WS = "household-payroll";
let db, FieldValue, ex, baby, repair, tenantDb;
let run = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const admin = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin: { firestore: { FieldValue } } } = await admin.getAdmin());
  ex = await import("../../netlify/functions/_lib/expenses.js");
  baby = await import("../../netlify/functions/_lib/baby.js");
  repair = await import("../../netlify/functions/_lib/category-totals.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
});

async function world() {
  run += 1;
  const id = `catt-${Date.now().toString(36)}-${run}`;
  const tenant = tenantDb(db, id);
  const business = { id, timezone: "Asia/Manila" };
  const cat = async (name) => (await baby.createCategory({ db, tenant, FieldValue, input: { name, budget: null }, actor, workspace: WS })).categoryId;
  return { tenant, business, cat };
}
const budget = async (w) => (await w.tenant.doc("budgets", "current").get()).data();

describe("category totals (real Firestore)", () => {
  it("notes and Paid by edits keep spentByCategory", async () => {
    const w = await world();
    const a = await w.cat("Groceries");
    const { expenseId } = await ex.createExpense({ db, tenant: w.tenant, FieldValue, business: w.business, workspace: WS, actor, now: NOW, input: { date: "2026-10-08", category: a, amount: 100000, method: "cash", paidBy: [{ name: "Mom", amount: 100000 }] } });
    await ex.updateExpense({ db, tenant: w.tenant, FieldValue, business: w.business, workspace: WS, actor, now: NOW, expenseId, changes: { notes: "Weekly" } });
    await ex.updateExpense({ db, tenant: w.tenant, FieldValue, business: w.business, workspace: WS, actor, now: NOW, expenseId, changes: { paidBy: [{ name: "Dad", amount: 100000 }] } });
    const b = await budget(w);
    expect(b.spentByCategory).toEqual({ [a]: 100000 });
    expect(b.spentByPayer).toEqual({ mom: 0, dad: 100000 });
    expect(b.spent).toBe(100000);
  });

  it("the repair rebuilds a wiped split from the active expenses", async () => {
    const w = await world();
    const a = await w.cat("Groceries");
    const b2 = await w.cat("Utilities");
    await ex.createExpense({ db, tenant: w.tenant, FieldValue, business: w.business, workspace: WS, actor, now: NOW, input: { date: "2026-10-08", category: a, amount: 70000, method: "cash" } });
    await ex.createExpense({ db, tenant: w.tenant, FieldValue, business: w.business, workspace: WS, actor, now: NOW, input: { date: "2026-10-08", category: b2, amount: 30000, method: "cash" } });
    // The damaged state as production had it: an empty map written with merge.
    await w.tenant.doc("budgets", "current").set({ spentByCategory: {} }, { merge: true });
    expect((await budget(w)).spentByCategory).toEqual({});
    const r = await repair.recomputeCategoryTotals({ db, tenant: w.tenant, FieldValue, apply: true, actor });
    expect(r.applied).toBe(true);
    expect((await budget(w)).spentByCategory).toEqual({ [a]: 70000, [b2]: 30000 });
    expect((await budget(w)).spent).toBe(100000);
  });
});
