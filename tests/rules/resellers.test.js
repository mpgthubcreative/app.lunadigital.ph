// Reseller Package (2026-10-31) under the Firestore rules: a Reseller
// business's snapshot (template "reseller" v1 with the Resellers module) is
// valid, so its members read their own orders as in Distributor; every
// reseller record (resellers, links, prices, payouts) is server-only, even
// for the Owner; another business and signed-out clients reach nothing; the
// top-level link index is never readable.
import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { businessDoc, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const R = "rs-rules-a";
const R2 = "rs-rules-b";
beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [R, R2]) {
      await db.doc(`businesses/${bid}`).set(businessDoc(`Biz ${bid}`, "active", { planId: "reseller-basic", workspaceTemplateId: "reseller" }));
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
      await seedMember(db, bid, `staff@${bid}`, { role: "staff" });
      await db.doc(`businesses/${bid}/orders/o1`).set({ orderNumber: "ORD-1", total: 130000, resellerId: "res1", reseller: { id: "res1", name: "Riza" }, commission: { calculated: 30000, final: 30000, adjusted: false } });
      await db.doc(`businesses/${bid}/resellers/res1`).set({ name: "Riza", status: "active", earned: 30000, paid: 0 });
      await db.doc(`businesses/${bid}/resellerLinks/res1`).set({ token: "secret-token", hash: "h1" });
      await db.doc(`businesses/${bid}/resellerPrices/res1_p1`).set({ resellerId: "res1", productId: "p1", price: 65000 });
      await db.doc(`businesses/${bid}/commissionPayouts/cp1`).set({ resellerId: "res1", amount: 10000, state: "paid" });
    }
    await db.doc("resellerMenuLinks/h1").set({ businessId: R, resellerId: "res1" });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

const SERVER_ONLY = ["resellers/res1", "resellerLinks/res1", "resellerPrices/res1_p1", "commissionPayouts/cp1"];

describe("a Reseller business under the rules", () => {
  it("its snapshot is valid: the Owner and Staff read their own orders (the reseller tag included)", async () => {
    await assertSucceeds(dbAs(env, `owner@${R}`).doc(`businesses/${R}/orders/o1`).get());
    await assertSucceeds(dbAs(env, `staff@${R}`).doc(`businesses/${R}/orders/o1`).get());
  });

  it("reseller records are server-only: not even the Owner reads or writes them", async () => {
    for (const p of SERVER_ONLY) {
      await assertFails(dbAs(env, `owner@${R}`).doc(`businesses/${R}/${p}`).get());
      await assertFails(dbAs(env, `owner@${R}`).doc(`businesses/${R}/${p}`).set({ x: 1 }));
    }
    for (const col of ["resellers", "resellerLinks", "resellerPrices", "commissionPayouts"]) await assertFails(dbAs(env, `owner@${R}`).collection(`businesses/${R}/${col}`).get());
    // Nobody can raise an earned / paid total or fake a payout from a client.
    await assertFails(dbAs(env, `owner@${R}`).doc(`businesses/${R}/resellers/res1`).update({ paid: 0, earned: 999999 }));
    await assertFails(dbAs(env, `owner@${R}`).doc(`businesses/${R}/commissionPayouts/cp2`).set({ resellerId: "res1", amount: 1 }));
  });

  it("another business and signed-out clients reach nothing; the link index is never readable", async () => {
    await assertFails(dbAs(env, `owner@${R2}`).doc(`businesses/${R}/orders/o1`).get());
    for (const p of SERVER_ONLY) await assertFails(dbAs(env, `owner@${R2}`).doc(`businesses/${R}/${p}`).get());
    await assertFails(dbAnon(env).doc(`businesses/${R}/orders/o1`).get());
    await assertFails(dbAnon(env).doc("resellerMenuLinks/h1").get());
    await assertFails(dbAs(env, `owner@${R}`).doc("resellerMenuLinks/h1").get());
    await assertFails(dbAs(env, `owner@${R}`).collection("resellerMenuLinks").get());
  });
});
