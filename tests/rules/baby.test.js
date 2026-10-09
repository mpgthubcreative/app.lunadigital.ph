// Phase 15 rules: Baby data (the budget, categories, spending metrics,
// providers, the payment schedule and Baby Expenses) is readable only by
// members of THAT Baby business with the module's view permission, only in
// the baby-expense workspace; nothing is browser-writable. Strict step:
// only baby-expense v2 snapshots carrying every Baby key (as a boolean) are
// valid; v1, missing / unknown / string versions and missing or non-bool
// Baby keys fail closed; forged Baby modules in other workspaces open nothing.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, businessDoc, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const K = "baby-a";
const K2 = "baby-b";
const COLLECTIONS = { budgets: "budget.view", expenseCategories: "budget.view", spendingMetrics: "budget.view", providers: "providers.view", scheduledPayments: "schedule.view", expenses: "expenses.view" };
const BABY_ONLY = ["budgets", "expenseCategories", "spendingMetrics", "providers", "scheduledPayments"];
const doc = { status: "active", date: "2026-10-10", dueDate: "2026-12-15", category: "c1", providerId: "p1", nameLower: "abc", type: "medical", order: 10 };

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [K, K2]) {
      await db.doc(`businesses/${bid}`).set(businessDoc(`Baby ${bid}`, "active", { planId: "growth", workspaceTemplateId: "baby-expense" }));
      for (const c of Object.keys(COLLECTIONS)) await db.doc(`businesses/${bid}/${c}/d1`).set({ ...doc, status: c === "scheduledPayments" ? "upcoming" : "active" });
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
    }
    await seedMember(db, K, "manager@baby-a", { role: "manager" });
    await seedMember(db, K, "staff@baby-a", { role: "staff" });
    await seedMember(db, K, "noBudget@baby-a", { role: "manager", overrides: { revoke: ["budget.view"] } });
    // Baby collections in a Distributor and a Household business: not reachable.
    for (const c of BABY_ONLY) await db.doc(`businesses/${A}/${c}/d1`).set({ x: 1 });
    await db.doc("businesses/home-x").set(businessDoc("Home", "active", { planId: "growth", workspaceTemplateId: "household-payroll" }));
    await seedMember(db, "home-x", "owner@home-x", { role: "owner", isAccountOwner: true });
    for (const c of Object.keys(COLLECTIONS)) await db.doc(`businesses/home-x/${c}/d1`).set({ x: 1 });
    // Strict step: a Baby business still on its v1 snapshot (no Baby keys, Expenses off) is stale.
    const v1 = businessDoc("Baby v1", "active", { planId: "growth", workspaceTemplateId: "baby-expense" });
    for (const k of ["budget", "schedule", "providers"]) delete v1.entitlements.modules[k];
    v1.entitlements.modules.expenses = false;
    v1.entitlements.workspaceTemplateVersion = 1;
    await db.doc("businesses/baby-v1").set(v1);
    await seedMember(db, "baby-v1", "owner@baby-v1", { role: "owner", isAccountOwner: true });
    for (const c of Object.keys(COLLECTIONS)) await db.doc(`businesses/baby-v1/${c}/d1`).set({ x: 1 });
    await db.doc("businesses/baby-v1/settings/general").set({ x: 1 });
    // Malformed / stale: v1 with every key, unknown, missing and string versions, missing Baby keys, non-bool keys.
    const STALE = {
      "baby-v1keys": (e) => { e.workspaceTemplateVersion = 1; },
      "baby-v3": (e) => { e.workspaceTemplateVersion = 3; },
      "baby-nover": (e) => { delete e.workspaceTemplateVersion; },
      "baby-vstr": (e) => { e.workspaceTemplateVersion = "2"; },
      "baby-nokeys": (e) => { for (const k of ["budget", "schedule", "providers"]) delete e.modules[k]; },
      "baby-nobudget": (e) => { delete e.modules.budget; },
      "baby-noschedule": (e) => { delete e.modules.schedule; },
      "baby-noproviders": (e) => { delete e.modules.providers; },
      "baby-bad": (e) => { e.modules.budget = "yes"; },
    };
    for (const [bid, mutate] of Object.entries(STALE)) {
      const b = businessDoc(bid, "active", { planId: "growth", workspaceTemplateId: "baby-expense" });
      mutate(b.entitlements);
      await db.doc(`businesses/${bid}`).set(b);
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
      await db.doc(`businesses/${bid}/budgets/d1`).set({ x: 1 });
      await db.doc(`businesses/${bid}/settings/general`).set({ x: 1 });
    }
    // Distributor / Household snapshots missing a Baby key are stale too.
    for (const [bid, t] of [["dist-nobaby", "distributor"], ["home-nobaby", "household-payroll"]]) {
      const b = businessDoc(bid, "active", { planId: "growth", workspaceTemplateId: t });
      delete b.entitlements.modules.schedule;
      await db.doc(`businesses/${bid}`).set(b);
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
      await db.doc(`businesses/${bid}/settings/general`).set({ x: 1 });
    }
    // Baby modules forged into Distributor, Household and Bridal snapshots.
    for (const [bid, t] of [["dist-forged", "distributor"], ["home-forged", "household-payroll"], ["bridal-forged", "bridal-expense"]]) {
      const f = businessDoc(`Forged ${t}`, "active", { planId: "growth", workspaceTemplateId: t });
      for (const k of ["budget", "schedule", "providers", "expenses"]) f.entitlements.modules[k] = true;
      await db.doc(`businesses/${bid}`).set(f);
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
      for (const c of BABY_ONLY) await db.doc(`businesses/${bid}/${c}/d1`).set({ x: 1 });
    }
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("reading Baby data", () => {
  for (const uid of ["owner@baby-a", "manager@baby-a"]) {
    it(`${uid} reads every Baby collection and runs the screens' queries`, async () => {
      const db = dbAs(env, uid);
      for (const c of Object.keys(COLLECTIONS)) await assertSucceeds(db.doc(`businesses/${K}/${c}/d1`).get());
      await assertSucceeds(db.collection(`businesses/${K}/expenseCategories`).orderBy("order").limit(50).get());
      await assertSucceeds(db.collection(`businesses/${K}/providers`).where("status", "==", "active").orderBy("nameLower").limit(26).get());
      await assertSucceeds(db.collection(`businesses/${K}/scheduledPayments`).where("status", "==", "upcoming").orderBy("dueDate").limit(26).get());
      await assertSucceeds(db.collection(`businesses/${K}/expenses`).where("status", "==", "active").where("providerId", "==", "p1").orderBy("date", "desc").limit(26).get());
    });
  }

  it("Baby Staff (no Baby permissions) and a manager without budget.view are refused", async () => {
    for (const c of Object.keys(COLLECTIONS)) await assertFails(dbAs(env, "staff@baby-a").doc(`businesses/${K}/${c}/d1`).get());
    for (const c of ["budgets", "expenseCategories", "spendingMetrics"]) await assertFails(dbAs(env, "noBudget@baby-a").doc(`businesses/${K}/${c}/d1`).get());
    await assertSucceeds(dbAs(env, "noBudget@baby-a").doc(`businesses/${K}/scheduledPayments/d1`).get());
  });

  it("Baby B, a Distributor owner, a Household owner, signed-out users: nothing of Baby A", async () => {
    for (const c of Object.keys(COLLECTIONS)) {
      for (const uid of ["owner@baby-b", "ownerA", "owner@home-x"]) {
        await assertFails(dbAs(env, uid).doc(`businesses/${K}/${c}/d1`).get());
        await assertFails(dbAs(env, uid).collection(`businesses/${K}/${c}`).get());
      }
      await assertFails(dbAnon(env).doc(`businesses/${K}/${c}/d1`).get());
    }
  });

  it("Distributor and Household businesses never expose Baby collections, even to their owner", async () => {
    for (const c of BABY_ONLY) await assertFails(dbAs(env, "ownerA").doc(`businesses/${A}/${c}/d1`).get());
    for (const c of Object.keys(COLLECTIONS)) await assertFails(dbAs(env, "owner@home-x").doc(`businesses/home-x/${c}/d1`).get());
  });

  it("forged Baby modules in Distributor / Household / Bridal snapshots open nothing of Baby's own", async () => {
    for (const bid of ["dist-forged", "home-forged"]) for (const c of BABY_ONLY) await assertFails(dbAs(env, `owner@${bid}`).doc(`businesses/${bid}/${c}/d1`).get());
    // Since Phase 16 Bridal legitimately owns the shared budget primitive; Baby's schedule and providers stay closed.
    for (const c of ["providers", "scheduledPayments"]) await assertFails(dbAs(env, "owner@bridal-forged").doc(`businesses/bridal-forged/${c}/d1`).get());
  });

  it("strict: the current Baby v2 snapshot works", async () => {
    await assertSucceeds(dbAs(env, `owner@${K}`).doc(`businesses/${K}/budgets/d1`).get());
    await assertSucceeds(dbAs(env, `owner@${K}`).doc(`businesses/${K}/expenses/d1`).get());
  });

  it("strict: a v1 Baby snapshot (pre-Phase-15) fails closed: Baby data AND settings", async () => {
    await assertFails(dbAs(env, "owner@baby-v1").doc("businesses/baby-v1/settings/general").get());
    for (const c of Object.keys(COLLECTIONS)) await assertFails(dbAs(env, "owner@baby-v1").doc(`businesses/baby-v1/${c}/d1`).get());
  });

  for (const [bid, what] of [["baby-v1keys", "v1 with every Baby key"], ["baby-v3", "unknown future version"], ["baby-nover", "missing version"], ["baby-vstr", "version as a string"], ["baby-nokeys", "v2 missing every Baby key"], ["baby-nobudget", "v2 missing budget"], ["baby-noschedule", "v2 missing schedule"], ["baby-noproviders", "v2 missing providers"], ["baby-bad", "a non-bool Baby key"]]) {
    it(`strict: ${what} fails closed (budget AND settings)`, async () => {
      await assertFails(dbAs(env, `owner@${bid}`).doc(`businesses/${bid}/budgets/d1`).get());
      await assertFails(dbAs(env, `owner@${bid}`).doc(`businesses/${bid}/settings/general`).get());
    });
  }

  it("strict: Distributor / Household snapshots missing a Baby key fail closed", async () => {
    for (const bid of ["dist-nobaby", "home-nobaby"]) await assertFails(dbAs(env, `owner@${bid}`).doc(`businesses/${bid}/settings/general`).get());
  });
});

describe("no browser writes", () => {
  it("not the budget, its totals, categories, providers, scheduled payments or expenses", async () => {
    const db = dbAs(env, "owner@baby-a");
    await assertFails(db.doc(`businesses/${K}/budgets/current`).set({ total: 1, spent: 0 }));
    await assertFails(db.doc(`businesses/${K}/budgets/d1`).update({ spent: 0 }));
    await assertFails(db.doc(`businesses/${K}/spendingMetrics/2026-10`).set({ spent: 0 }));
    await assertFails(db.doc(`businesses/${K}/expenseCategories/d1`).update({ useCount: 0 }));
    await assertFails(db.doc(`businesses/${K}/expenseCategories/d1`).delete());
    await assertFails(db.doc(`businesses/${K}/providers/new`).set({ name: "x" }));
    await assertFails(db.doc(`businesses/${K}/scheduledPayments/d1`).update({ status: "paid" }));
    await assertFails(db.doc(`businesses/${K}/expenses/new`).set({ amount: 1 }));
  });
});
