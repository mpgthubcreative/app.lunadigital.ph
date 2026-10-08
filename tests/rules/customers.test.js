// Phase 9 rules: customers are readable with customers.view (Customers
// module on, Distributor v2 workspace); the order-history query needs
// orders.view too; nothing is writable from the browser; no other tenant
// and no non-Distributor workspace can read them.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, B, DOC, OUTSIDER, businessDoc, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const CID = "custAAAAAAAAAAAAAAAA";

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [A, B]) {
      await db.doc(`businesses/${bid}/customers/${CID}`).set({ name: "ABC Store", nameLower: "abc store", status: "active", stats: { orderCount: 1, totalOrdered: 100000, outstandingBalance: 60000 } });
      await db.doc(`businesses/${bid}/orders/orderLINKED000000001`).set({ customerId: CID, total: 100000, balance: 60000, createdAt: new Date() });
    }
    await seedMember(db, A, "noCustStaffA", { role: "staff", overrides: { revoke: ["customers.view"] } });
    await seedMember(db, A, "noOrdersCustStaffA", { role: "staff", overrides: { revoke: ["orders.view"] } });
    await db.doc("businesses/cust-off").set(businessDoc("Customers off", "active", { planId: "growth", overrides: { modules: { customers: false } } }));
    await seedMember(db, "cust-off", "ownerCustOff", { role: "owner", isAccountOwner: true });
    await db.doc(`businesses/cust-off/customers/${CID}`).set({ name: "x" });
    await db.doc("businesses/cust-bridal").set(businessDoc("Wedding", "active", { planId: "pro", workspaceTemplateId: "bridal-expense" }));
    await seedMember(db, "cust-bridal", "ownerBridal", { role: "owner", isAccountOwner: true });
    await db.doc(`businesses/cust-bridal/customers/${CID}`).set({ name: "x" });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

const get = (uid, path) => dbAs(env, uid).doc(path).get();

describe("reading customers", () => {
  for (const uid of ["ownerA", "managerA", "staffA"]) {
    it(`${uid} reads A's customers and runs the screen's queries`, async () => {
      const db = dbAs(env, uid);
      await assertSucceeds(get(uid, `businesses/${A}/customers/${CID}`));
      await assertSucceeds(db.collection(`businesses/${A}/customers`).where("status", "==", "active").orderBy("nameLower").limit(25).get());
      await assertSucceeds(db.collection(`businesses/${A}/orders`).where("customerId", "==", CID).orderBy("createdAt", "desc").limit(25).get());
    });

    it(`${uid} can't read B's customers or B's orders by customer`, async () => {
      await assertFails(get(uid, `businesses/${B}/customers/${CID}`));
      await assertFails(dbAs(env, uid).collection(`businesses/${B}/customers`).get());
      await assertFails(dbAs(env, uid).collection(`businesses/${B}/orders`).where("customerId", "==", CID).get());
    });

    it(`${uid} can't write customers or their statistics from the browser`, async () => {
      const db = dbAs(env, uid);
      await assertFails(db.doc(`businesses/${A}/customers/newCustomer00000001`).set({ name: "Mine", status: "active" }));
      await assertFails(db.doc(`businesses/${A}/customers/${CID}`).update({ "stats.outstandingBalance": 0 }));
      await assertFails(db.doc(`businesses/${A}/customers/${CID}`).update({ status: "inactive" }));
      await assertFails(db.doc(`businesses/${A}/customers/${CID}`).delete());
      await assertFails(db.doc(`businesses/${A}/orders/orderLINKED000000001`).update({ customerId: "custBBBBBBBBBBBBBBBB" }));
    });
  }

  it("without customers.view: no customers (orders still fine)", async () => {
    await assertFails(get("noCustStaffA", `businesses/${A}/customers/${CID}`));
    await assertSucceeds(get("noCustStaffA", `businesses/${A}/orders/orderLINKED000000001`));
  });

  it("customer record without orders.view: the order-history query is refused", async () => {
    await assertSucceeds(get("noOrdersCustStaffA", `businesses/${A}/customers/${CID}`));
    await assertFails(dbAs(env, "noOrdersCustStaffA").collection(`businesses/${A}/orders`).where("customerId", "==", CID).get());
  });

  it("Customers module off: nothing, even for the owner", async () => {
    await assertFails(get("ownerCustOff", `businesses/cust-off/customers/${CID}`));
  });

  it("a bridal workspace never reads Distributor customers (even its own collection)", async () => {
    await assertFails(get("ownerBridal", `businesses/cust-bridal/customers/${CID}`));
  });

  it("signed out and outsiders: nothing", async () => {
    await assertFails(dbAnon(env).doc(`businesses/${A}/customers/${CID}`).get());
    await assertFails(get(OUTSIDER, `businesses/${A}/customers/${CID}`));
  });

  it("collection-group queries across tenants stay refused", async () => {
    await assertFails(dbAs(env, "ownerA").collectionGroup("customers").get());
  });
});

it("unused seed doc is untouched", async () => {
  await assertFails(get("staffA", `businesses/${A}/integrations/${DOC}`));
});
