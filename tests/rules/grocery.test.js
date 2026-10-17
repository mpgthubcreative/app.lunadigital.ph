// Luna Household Grocery List rules: readable by members of THAT household
// with grocery.view (Owner, Admin and the kasambahay's own login), only in
// the household-payroll workspace with the module on; never browser-
// writable. A kasambahay reading the list still can't read any money.
// Rollout: a v3 snapshot without the grocery key stays valid and reads the
// list as off.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, businessDoc, createEnv, dbAs, seedMember } from "./fixture.js";

let env;
const H = "home-g";
const H2 = "home-g2";
const V3 = "home-g-v3";
const BRIDE = "bridal-g-forged";

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [H, H2]) {
      await db.doc(`businesses/${bid}`).set(businessDoc(`Home ${bid}`, "active", { planId: "household-plus", workspaceTemplateId: "household-payroll" }));
      await db.doc(`businesses/${bid}/groceryItems/i1`).set({ name: "Eggs", bought: false });
      await db.doc(`businesses/${bid}/groceryLists/current`).set({ staffCanAdd: false });
      await db.doc(`businesses/${bid}/expenses/e1`).set({ amount: 1 });
      await db.doc(`businesses/${bid}/budgets/current`).set({ total: 1 });
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
    }
    await seedMember(db, H, "manager@home-g", { role: "manager" });
    await seedMember(db, H, "helper@home-g", { role: "household_staff" });
    // A v3 snapshot from before the Grocery List (no grocery key).
    const old = businessDoc("Old home", "active", { planId: "household-plus", workspaceTemplateId: "household-payroll" });
    old.entitlements.workspaceTemplateVersion = 3;
    delete old.entitlements.modules.grocery;
    await db.doc(`businesses/${V3}`).set(old);
    await seedMember(db, V3, `owner@${V3}`, { role: "owner", isAccountOwner: true });
    await db.doc(`businesses/${V3}/groceryItems/i1`).set({ name: "Eggs" });
    await db.doc(`businesses/${V3}/settings/general`).set({ x: 1 });
    // Grocery forged into a Bridal snapshot.
    const f = businessDoc("Forged bridal", "active", { planId: "bridal-plus", workspaceTemplateId: "bridal-expense" });
    f.entitlements.modules.grocery = true;
    await db.doc(`businesses/${BRIDE}`).set(f);
    await seedMember(db, BRIDE, `owner@${BRIDE}`, { role: "owner", isAccountOwner: true });
    await db.doc(`businesses/${BRIDE}/groceryItems/i1`).set({ name: "Eggs" });
    await db.doc(`businesses/${A}/groceryItems/i1`).set({ name: "Eggs" });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("Grocery List rules", () => {
  it("Owner, Admin and the kasambahay read the list and its setting", async () => {
    for (const uid of [`owner@${H}`, "manager@home-g", "helper@home-g"]) {
      await assertSucceeds(dbAs(env, uid).doc(`businesses/${H}/groceryItems/i1`).get());
      await assertSucceeds(dbAs(env, uid).collection(`businesses/${H}/groceryItems`).get());
      await assertSucceeds(dbAs(env, uid).doc(`businesses/${H}/groceryLists/current`).get());
    }
  });

  it("the kasambahay still can't read money (expenses, budget)", async () => {
    await assertFails(dbAs(env, "helper@home-g").doc(`businesses/${H}/expenses/e1`).get());
    await assertFails(dbAs(env, "helper@home-g").doc(`businesses/${H}/budgets/current`).get());
  });

  it("nobody writes from the browser (only /api/grocery)", async () => {
    for (const uid of [`owner@${H}`, "helper@home-g"]) {
      await assertFails(dbAs(env, uid).doc(`businesses/${H}/groceryItems/i1`).update({ bought: true }));
      await assertFails(dbAs(env, uid).doc(`businesses/${H}/groceryItems/new1`).set({ name: "Milk" }));
      await assertFails(dbAs(env, uid).doc(`businesses/${H}/groceryItems/i1`).delete());
      await assertFails(dbAs(env, uid).doc(`businesses/${H}/groceryLists/current`).set({ staffCanAdd: true }));
    }
  });

  it("another household's list: closed", async () => {
    await assertFails(dbAs(env, "helper@home-g").doc(`businesses/${H2}/groceryItems/i1`).get());
    await assertFails(dbAs(env, `owner@${H2}`).doc(`businesses/${H}/groceryItems/i1`).get());
  });

  it("rollout: a v3 snapshot without the grocery key stays valid (settings readable) and the list reads as off", async () => {
    await assertSucceeds(dbAs(env, `owner@${V3}`).doc(`businesses/${V3}/settings/general`).get());
    await assertFails(dbAs(env, `owner@${V3}`).doc(`businesses/${V3}/groceryItems/i1`).get());
  });

  it("Distributor and a Bridal snapshot forged with grocery: closed (template ceiling)", async () => {
    await assertFails(dbAs(env, "ownerA").doc(`businesses/${A}/groceryItems/i1`).get());
    await assertFails(dbAs(env, `owner@${BRIDE}`).doc(`businesses/${BRIDE}/groceryItems/i1`).get());
  });
});
