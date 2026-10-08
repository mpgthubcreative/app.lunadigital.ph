// Phase 7 rules: orders readable with orders.view, per-order COGS only with
// dashboard.financials (and the Orders module), no browser writes to orders,
// costs, counters, usage or idempotency keys, and nothing across tenants.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, B, STATUS_TENANTS, businessDoc, createEnv, dbAs, seedMember, statusUid } from "./fixture.js";

let env;
const OID = "orderAAAAAAAAAAAAAAA";

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [A, B, STATUS_TENANTS.cancelled.bid, STATUS_TENANTS.suspended.bid]) {
      await db.doc(`businesses/${bid}/orders/${OID}`).set({ orderNumber: "ORD-20261008-001", fulfillmentStatus: "fulfilled", paymentStatus: "unpaid", total: 75000, createdAt: new Date() });
      await db.doc(`businesses/${bid}/orderCosts/${OID}`).set({ cogs: 50000, grossProfit: 25000 });
      await db.doc(`businesses/${bid}/counters/orders-20261008`).set({ next: 2 });
      await db.doc(`businesses/${bid}/usage/2026-10`).set({ ordersCreated: 1 });
      await db.doc(`businesses/${bid}/idempotencyKeys/key-0000000000000001`).set({ orderId: OID });
    }
    await seedMember(db, A, "finStaffA", { role: "staff", overrides: { grant: ["dashboard.financials"] } });
    await seedMember(db, A, "noOrdersStaffA", { role: "staff", overrides: { revoke: ["orders.view"] } });
    await db.doc("businesses/orders-off").set(businessDoc("Orders off", "active", { planId: "growth", overrides: { modules: { orders: false } } }));
    await seedMember(db, "orders-off", "ownerOff", { role: "owner", isAccountOwner: true });
    await db.doc(`businesses/orders-off/orders/${OID}`).set({ total: 1 });
    await db.doc(`businesses/orders-off/orderCosts/${OID}`).set({ cogs: 1 });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

const get = (uid, path) => dbAs(env, uid).doc(path).get();

describe("reading orders and their costs", () => {
  for (const uid of ["ownerA", "managerA", "staffA"]) {
    it(`${uid} reads orders and runs the screen's queries`, async () => {
      const db = dbAs(env, uid);
      await assertSucceeds(get(uid, `businesses/${A}/orders/${OID}`));
      await assertSucceeds(db.collection(`businesses/${A}/orders`).orderBy("createdAt", "desc").limit(25).get());
      await assertSucceeds(db.collection(`businesses/${A}/orders`).where("fulfillmentStatus", "==", "pending").orderBy("createdAt", "desc").limit(25).get());
    });
  }

  it("COGS / profit: owner, manager and a granted staff member yes; plain staff no", async () => {
    for (const uid of ["ownerA", "managerA", "finStaffA"]) await assertSucceeds(get(uid, `businesses/${A}/orderCosts/${OID}`));
    await assertFails(get("staffA", `businesses/${A}/orderCosts/${OID}`));
    await assertFails(dbAs(env, "staffA").collection(`businesses/${A}/orderCosts`).get());
  });

  it("without orders.view: no orders", async () => {
    await assertFails(get("noOrdersStaffA", `businesses/${A}/orders/${OID}`));
  });

  it("Orders module off: neither orders nor their costs, even for the owner", async () => {
    await assertFails(get("ownerOff", `businesses/orders-off/orders/${OID}`));
    await assertFails(get("ownerOff", `businesses/orders-off/orderCosts/${OID}`));
  });

  it("counters, usage and idempotency keys are server-only", async () => {
    for (const path of [`businesses/${A}/counters/orders-20261008`, `businesses/${A}/usage/2026-10`, `businesses/${A}/idempotencyKeys/key-0000000000000001`]) {
      await assertFails(get("ownerA", path));
    }
  });

  it("cancelled business: orders aren't export-only, so even the owner can't read them", async () => {
    const bid = STATUS_TENANTS.cancelled.bid;
    await assertFails(get(statusUid("owner", bid), `businesses/${bid}/orders/${OID}`));
  });
});

describe("no browser writes", () => {
  for (const uid of ["ownerA", "managerA", "staffA", "finStaffA"]) {
    it(`${uid}: can't create, edit, fulfil, cancel, re-price or touch counters`, async () => {
      const db = dbAs(env, uid);
      const order = db.doc(`businesses/${A}/orders/${OID}`);
      await assertFails(db.collection(`businesses/${A}/orders`).add({ total: 1, items: [] }));
      await assertFails(db.doc(`businesses/${A}/orders/newOrderAAAAAAAAAAAA`).set({ total: 1 }));
      await assertFails(order.update({ total: 1 }));
      await assertFails(order.update({ fulfillmentStatus: "cancelled" }));
      await assertFails(order.update({ amountPaid: 75000, paymentStatus: "paid" }));
      await assertFails(order.update({ items: [] }));
      await assertFails(order.delete());
      await assertFails(db.doc(`businesses/${A}/orderCosts/${OID}`).update({ cogs: 0 }));
      await assertFails(db.doc(`businesses/${A}/orderCosts/${OID}`).set({ cogs: 0 }));
      await assertFails(db.doc(`businesses/${A}/counters/orders-20261008`).set({ next: 1 }));
      await assertFails(db.doc(`businesses/${A}/usage/2026-10`).set({ ordersCreated: 0 }));
      await assertFails(db.doc(`businesses/${A}/idempotencyKeys/forged-key-00000001`).set({ orderId: OID }));
      await assertFails(db.doc(`businesses/${A}/metrics/2026-10-08`).set({ orderCount: 0 }));
      await assertFails(db.doc(`businesses/${A}/financialMetrics/2026-10-08`).set({ grossSales: 0 }));
    });
  }

  it("suspended: reads continue, still no writes", async () => {
    const bid = STATUS_TENANTS.suspended.bid;
    await assertSucceeds(get(statusUid("staff", bid), `businesses/${bid}/orders/${OID}`));
    await assertFails(dbAs(env, statusUid("owner", bid)).doc(`businesses/${bid}/orders/${OID}`).update({ total: 0 }));
  });

  it("staff can't grant themselves dashboard.financials to see COGS", async () => {
    await assertFails(dbAs(env, "staffA").doc(`businesses/${A}/members/staffA`).update({ "permissions.dashboard": true }));
    await assertFails(dbAs(env, "staffA", { "dashboard.financials": true }).doc(`businesses/${A}/orderCosts/${OID}`).get());
  });
});

describe("Business A never reads or changes Business B's orders", () => {
  for (const uid of ["ownerA", "managerA", "staffA", "finStaffA"]) {
    it(`${uid}`, async () => {
      const db = dbAs(env, uid);
      for (const c of ["orders", "orderCosts", "counters", "usage", "idempotencyKeys"]) {
        await assertFails(db.collection(`businesses/${B}/${c}`).get());
        await assertFails(db.collectionGroup(c).get());
      }
      await assertFails(get(uid, `businesses/${B}/orders/${OID}`));
      await assertFails(get(uid, `businesses/${B}/orderCosts/${OID}`));
      await assertFails(db.collection(`businesses/${B}/orders`).where("fulfillmentStatus", "==", "fulfilled").orderBy("createdAt", "desc").get());
      await assertFails(db.doc(`businesses/${B}/orders/${OID}`).update({ fulfillmentStatus: "cancelled" }));
    });
  }
});
