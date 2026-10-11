// Phase 18.6 rules: Luna's own billing and economics are server-only. A
// tenant Owner reaches their subscription only through /api/subscription and
// operators through /api/operator; no browser reads or writes invoices,
// payments (or their proofs), platform metrics, Luna's bank settings, its
// platform expenses or its cost rates. A tenant can never verify itself,
// move its paid-through date or read another tenant's proof.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails } from "@firebase/rules-unit-testing";
import { A, B, createEnv, dbAs, dbAnon, seedWorld } from "./fixture.js";

let env;
const PATHS = [`subscriptionInvoices/${A}_2026-10`, "subscriptionPayments/spA1", "platformMetrics/2026-10", "platformMetrics/current", "platform/billingSettings", "platformExpenses/e1", "platformCostRates/r1"];
beforeAll(async () => {
  env = await createEnv();
  await seedWorld(env);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc(`subscriptionInvoices/${A}_2026-10`).set({ businessId: A, period: "2026-10", amountDue: 199000, amountPaid: 0, status: "due" });
    await db.doc("subscriptionPayments/spA1").set({ businessId: A, status: "for_verification", amountSubmitted: 199000, proof: { path: `platformBilling/${A}/spA1.png` } });
    await db.doc("platformMetrics/2026-10").set({ verifiedRevenue: 199000 });
    await db.doc("platformMetrics/current").set({ outstanding: 0 });
    await db.doc("platform/billingSettings").set({ bankName: "BDO" });
    await db.doc("platformExpenses/e1").set({ month: "2026-10", amount: 142000 });
    await db.doc("platformCostRates/r1").set({ resource: "storage_gb_month", ratePerUnit: 150 });
    const st = ctx.storage();
    await st.ref(`platformBilling/${A}/spA1.png`).put(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { contentType: "image/png" });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("Luna billing and economics are server-only", () => {
  for (const uid of ["ownerA", "managerA", "staffA", "ownerB"]) {
    it(`${uid}: can't read or write invoices, payments, metrics, settings, expenses or rates`, async () => {
      const db = dbAs(env, uid);
      for (const p of PATHS) {
        await assertFails(db.doc(p).get());
        await assertFails(db.doc(p).set({ status: "paid", amountPaid: 199000 }));
      }
      for (const c of ["subscriptionInvoices", "subscriptionPayments", "platformMetrics", "platformExpenses", "platformCostRates"]) await assertFails(db.collection(c).get());
      // No self-verification or paid-through move through the business document either.
      await assertFails(db.doc(`businesses/${A}`).update({ "subscription.paidThrough": "2099-12-31" }));
    });
  }
  it("payment proofs: no browser reads or uploads, not even the paying Owner", async () => {
    for (const uid of ["ownerA", "ownerB"]) {
      const st = env.authenticatedContext(uid).storage();
      await assertFails(st.ref(`platformBilling/${A}/spA1.png`).getDownloadURL());
      await assertFails(st.ref(`platformBilling/${A}/forged.png`).put(new Uint8Array([1, 2, 3])));
    }
  });
  it("signed out: nothing", async () => {
    for (const p of PATHS) await assertFails(dbAnon(env).doc(p).get());
    void B;
  });
});
