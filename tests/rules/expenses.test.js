// Phase 10 rules: expenses are readable with expenses.view (Owner /
// Manager templates; Staff have none) on a Distributor v3 workspace;
// nothing about an expense or its metrics is writable from the browser;
// no other tenant and no non-Distributor workspace can read them.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, B, OUTSIDER, businessDoc, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const EID = "expAAAAAAAAAAAAAAAAA";

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [A, B]) {
      await db.doc(`businesses/${bid}/expenses/${EID}`).set({ date: "2026-10-08", category: "rent", amount: 500000, status: "active" });
      await db.doc(`businesses/${bid}/financialMetrics/2026-10-08`).set({ operatingExpenses: 500000 });
    }
    await seedMember(db, A, "bookkeeperA", { role: "staff", overrides: { grant: ["expenses.view"] } });
    await db.doc("businesses/exp-off").set(businessDoc("Expenses off", "active", { planId: "growth", overrides: { modules: { expenses: false } } }));
    await seedMember(db, "exp-off", "ownerExpOff", { role: "owner", isAccountOwner: true });
    await db.doc(`businesses/exp-off/expenses/${EID}`).set({ amount: 1 });
    for (const t of ["bridal-expense", "baby-expense"]) {
      const bid = `exp-${t}`;
      await db.doc(`businesses/${bid}`).set(businessDoc(t, "active", { planId: "pro", workspaceTemplateId: t }));
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
      await db.doc(`businesses/${bid}/expenses/${EID}`).set({ amount: 1 });
    }
    // A bridal snapshot forged to claim Expenses: the rules re-check the template.
    const forged = businessDoc("Forged bridal", "active", { planId: "pro", workspaceTemplateId: "bridal-expense" });
    forged.entitlements.modules.expenses = true;
    await db.doc("businesses/exp-forged").set(forged);
    await seedMember(db, "exp-forged", "owner@exp-forged", { role: "owner", isAccountOwner: true });
    await db.doc(`businesses/exp-forged/expenses/${EID}`).set({ amount: 1 });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

const get = (uid, path) => dbAs(env, uid).doc(path).get();

describe("reading expenses", () => {
  for (const uid of ["ownerA", "managerA"]) {
    it(`${uid} reads A's expenses and runs the page's queries`, async () => {
      const db = dbAs(env, uid);
      const ref = db.collection(`businesses/${A}/expenses`);
      await assertSucceeds(get(uid, `businesses/${A}/expenses/${EID}`));
      await assertSucceeds(ref.where("status", "==", "active").orderBy("date", "desc").limit(25).get());
      await assertSucceeds(ref.where("status", "==", "active").where("category", "==", "rent").where("date", ">=", "2026-10-01").orderBy("date", "desc").limit(25).get());
    });
  }

  it("staff (no expenses.view) are refused; a staff member granted expenses.view reads", async () => {
    await assertFails(get("staffA", `businesses/${A}/expenses/${EID}`));
    await assertFails(dbAs(env, "staffA").collection(`businesses/${A}/expenses`).get());
    await assertSucceeds(get("bookkeeperA", `businesses/${A}/expenses/${EID}`));
  });

  for (const uid of ["ownerA", "managerA", "staffA"]) {
    it(`${uid}: nothing of B's expenses, and no browser writes anywhere`, async () => {
      const db = dbAs(env, uid);
      await assertFails(get(uid, `businesses/${B}/expenses/${EID}`));
      await assertFails(db.collection(`businesses/${B}/expenses`).get());
      await assertFails(db.doc(`businesses/${A}/expenses/newExpense000000001`).set({ amount: 1, status: "active" }));
      await assertFails(db.doc(`businesses/${A}/expenses/${EID}`).update({ amount: 1 }));
      await assertFails(db.doc(`businesses/${A}/expenses/${EID}`).update({ status: "removed" }));
      await assertFails(db.doc(`businesses/${A}/expenses/${EID}`).delete());
      await assertFails(db.doc(`businesses/${A}/financialMetrics/2026-10-08`).set({ operatingExpenses: 0 }, { merge: true }));
      await assertFails(db.doc(`businesses/${B}/financialMetrics/2026-10-08`).set({ operatingExpenses: 0 }, { merge: true }));
    });
  }

  it("Expenses switched off for the business: nothing, even for the owner", async () => {
    await assertFails(get("ownerExpOff", `businesses/exp-off/expenses/${EID}`));
  });

  it("bridal / baby workspaces never read expenses (planned there, not operational)", async () => {
    for (const t of ["bridal-expense", "baby-expense"]) await assertFails(get(`owner@exp-${t}`, `businesses/exp-${t}/expenses/${EID}`));
  });

  it("a bridal snapshot forged to claim Expenses still can't read them (template ceiling in the rules)", async () => {
    await assertFails(get("owner@exp-forged", `businesses/exp-forged/expenses/${EID}`));
  });

  it("signed out, outsiders and collection-group queries: nothing", async () => {
    await assertFails(dbAnon(env).doc(`businesses/${A}/expenses/${EID}`).get());
    await assertFails(get(OUTSIDER, `businesses/${A}/expenses/${EID}`));
    await assertFails(dbAs(env, "ownerA").collectionGroup("expenses").get());
  });
});
