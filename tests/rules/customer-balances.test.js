// 2026-10-25 rules: a customer's special prices (customerPrices) and
// opening balances (openingBalances), and the Who owes us queries, are
// readable with customers.view in the business's own data only; nothing is
// writable from the browser; another business never sees them.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, B, OUTSIDER, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const CID = "custAAAAAAAAAAAAAAAA";
const PRICE = `${CID}_prodAAAAAAAAAAAAAAAA`;
const OB = `ob${"a".repeat(30)}`;

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [A, B]) {
      await db.doc(`businesses/${bid}/customers/${CID}`).set({ name: "Juan Store", nameLower: "juan store", status: "active", stats: { outstandingBalance: 185000 } });
      await db.doc(`businesses/${bid}/customerPrices/${PRICE}`).set({ customerId: CID, productId: "prodAAAAAAAAAAAAAAAA", price: 5000, active: true });
      await db.doc(`businesses/${bid}/openingBalances/${OB}`).set({ customerId: CID, amount: 185000, balance: 185000, status: "open", effectiveDay: "2026-10-01" });
      await db.doc(`businesses/${bid}/orders/orderUNPAID00000001`).set({ customerId: CID, total: 50000, balance: 50000, createdAt: new Date() });
    }
    await seedMember(db, A, "noCustStaffA2", { role: "staff", overrides: { revoke: ["customers.view"] } });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("special prices and opening balances", () => {
  for (const uid of ["ownerA", "managerA", "staffA"]) {
    it(`${uid}: reads A's, runs Who owes us and New Order's queries; never B's; never writes`, async () => {
      const db = dbAs(env, uid);
      await assertSucceeds(db.doc(`businesses/${A}/customerPrices/${PRICE}`).get());
      await assertSucceeds(db.collection(`businesses/${A}/customerPrices`).where("customerId", "==", CID).limit(1000).get());
      await assertSucceeds(db.collection(`businesses/${A}/openingBalances`).where("balance", ">", 0).limit(1000).get());
      await assertSucceeds(db.collection(`businesses/${A}/customers`).where("stats.outstandingBalance", ">", 0).orderBy("stats.outstandingBalance", "desc").limit(300).get());
      await assertSucceeds(db.collection(`businesses/${A}/orders`).where("balance", ">", 0).limit(1000).get());
      await assertFails(db.doc(`businesses/${B}/customerPrices/${PRICE}`).get());
      await assertFails(db.collection(`businesses/${B}/openingBalances`).get());
      await assertFails(db.doc(`businesses/${A}/customerPrices/${PRICE}`).set({ customerId: CID, price: 1 }));
      await assertFails(db.doc(`businesses/${A}/openingBalances/${OB}`).update({ balance: 0 }));
      await assertFails(db.doc(`businesses/${A}/openingBalances/ob${"b".repeat(30)}`).set({ customerId: CID, amount: 1 }));
    });
  }
  it("without customers.view: neither", async () => {
    await assertFails(dbAs(env, "noCustStaffA2").doc(`businesses/${A}/customerPrices/${PRICE}`).get());
    await assertFails(dbAs(env, "noCustStaffA2").doc(`businesses/${A}/openingBalances/${OB}`).get());
  });
  it("signed out and outsiders: nothing", async () => {
    await assertFails(dbAnon(env).doc(`businesses/${A}/openingBalances/${OB}`).get());
    await assertFails(dbAs(env, OUTSIDER).doc(`businesses/${A}/customerPrices/${PRICE}`).get());
  });
});
