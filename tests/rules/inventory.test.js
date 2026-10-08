// Phase 6 rules: quantities (inventory.view) vs costs (inventory.costs),
// no browser writes to products / balances / costs / history / SKU index,
// module + subscription gates, and no path across tenants.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, B, STATUS_TENANTS, businessDoc, createEnv, dbAs, seedMember, statusUid } from "./fixture.js";

let env;
const PID = "prodAAAAAAAAAAAAAAAA";
const COST_COLLECTIONS = ["productCosts", "inventoryTransactionCosts"];
const QTY_COLLECTIONS = ["products", "inventoryTransactions"];

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [A, B, STATUS_TENANTS.suspended.bid, STATUS_TENANTS.cancelled.bid]) {
      await db.doc(`businesses/${bid}/products/${PID}`).set({ sku: "RICE-25", name: "Rice", onHand: 140000, reserved: 0, available: 140000, isLowStock: false, status: "active" });
      await db.doc(`businesses/${bid}/productCosts/${PID}`).set({ avgCostUnits: 53333333, inventoryValue: 746667 });
      await db.doc(`businesses/${bid}/inventoryTransactions/tx1`).set({ productId: PID, seq: 1, type: "receipt", onHandDelta: 50000 });
      await db.doc(`businesses/${bid}/inventoryTransactionCosts/tx1`).set({ productId: PID, unitCost: 6000, avgCostAfter: 53333333 });
      await db.doc(`businesses/${bid}/skuIndex/RICE-25`).set({ productId: PID });
    }
    await seedMember(db, A, "receiverA", { role: "staff", overrides: { grant: ["inventory.receive"] } });
    await seedMember(db, A, "costStaffA", { role: "staff", overrides: { grant: ["inventory.costs"] } });
    await seedMember(db, A, "noCostManagerA", { role: "manager", overrides: { revoke: ["inventory.costs"] } });
    // Same business shape with the Inventory module switched off.
    await db.doc("businesses/inv-off").set(businessDoc("Inventory off", "active", { planId: "growth", overrides: { modules: { inventory: false } } }));
    await seedMember(db, "inv-off", "ownerOff", { role: "owner", isAccountOwner: true });
    await db.doc(`businesses/inv-off/products/${PID}`).set({ sku: "X", onHand: 1 });
    await db.doc(`businesses/inv-off/productCosts/${PID}`).set({ avgCostUnits: 1 });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

const get = (uid, bid, collection, id) => dbAs(env, uid).doc(`businesses/${bid}/${collection}/${id}`).get();
const idFor = (collection) => (collection.startsWith("inventoryTransaction") ? "tx1" : PID);

describe("who reads what in their own business", () => {
  for (const uid of ["ownerA", "managerA", "costStaffA"]) {
    it(`${uid} reads quantities AND costs`, async () => {
      for (const c of [...QTY_COLLECTIONS, ...COST_COLLECTIONS]) await assertSucceeds(get(uid, A, c, idFor(c)));
    });
  }
  for (const uid of ["staffA", "receiverA", "noCostManagerA"]) {
    it(`${uid} reads quantities but never costs`, async () => {
      for (const c of QTY_COLLECTIONS) await assertSucceeds(get(uid, A, c, idFor(c)));
      for (const c of COST_COLLECTIONS) {
        await assertFails(get(uid, A, c, idFor(c)));
        await assertFails(dbAs(env, uid).collection(`businesses/${A}/${c}`).get());
        await assertFails(dbAs(env, uid).collection(`businesses/${A}/${c}`).where("productId", "==", PID).get());
      }
    });
  }

  it("history queries by product (the screen's query) work for inventory.view", async () => {
    await assertSucceeds(dbAs(env, "staffA").collection(`businesses/${A}/inventoryTransactions`).where("productId", "==", PID).orderBy("seq", "desc").limit(20).get());
  });

  it("nobody reads the SKU index", async () => {
    for (const uid of ["ownerA", "managerA", "staffA"]) await assertFails(get(uid, A, "skuIndex", "RICE-25"));
  });
});

describe("no browser writes: stock, costs, history, SKUs", () => {
  for (const uid of ["ownerA", "managerA", "receiverA", "staffA"]) {
    it(`${uid} can't edit stock or cost, or forge history`, async () => {
      const db = dbAs(env, uid);
      const p = db.doc(`businesses/${A}/products/${PID}`);
      await assertFails(p.update({ onHand: 999999000 }));
      await assertFails(p.update({ available: 1, reserved: 0 }));
      await assertFails(p.update({ isLowStock: false }));
      await assertFails(p.update({ name: "Renamed" }));
      await assertFails(p.delete());
      await assertFails(db.doc(`businesses/${A}/products/newProductAAAAAAAAAA`).set({ sku: "NEW", onHand: 1 }));
      await assertFails(db.doc(`businesses/${A}/productCosts/${PID}`).update({ avgCostUnits: 1 }));
      await assertFails(db.doc(`businesses/${A}/productCosts/${PID}`).set({ avgCostUnits: 1 }));
      await assertFails(db.collection(`businesses/${A}/inventoryTransactions`).add({ productId: PID, type: "receipt", onHandDelta: 1000 }));
      await assertFails(db.doc(`businesses/${A}/inventoryTransactions/tx1`).update({ onHandDelta: 0 }));
      await assertFails(db.doc(`businesses/${A}/inventoryTransactions/tx1`).delete());
      await assertFails(db.doc(`businesses/${A}/inventoryTransactionCosts/tx1`).update({ unitCost: 1 }));
      await assertFails(db.doc(`businesses/${A}/skuIndex/RICE-25`).delete());
      await assertFails(db.doc(`businesses/${A}/skuIndex/FORGED`).set({ productId: PID }));
      await assertFails(db.doc(`businesses/${A}/metrics/current`).update({ lowStockProducts: 0 }));
      await assertFails(db.doc(`businesses/${A}/financialMetrics/current`).update({ inventoryValue: 0 }));
    });
  }
});

describe("permission escalation and forged claims", () => {
  it("staff can't grant themselves inventory.costs", async () => {
    await assertFails(dbAs(env, "staffA").doc(`businesses/${A}/members/staffA`).update({ permissions: { "inventory.costs": true, "inventory.view": true } }));
  });

  it("forged claims don't unlock costs", async () => {
    await assertFails(dbAs(env, "staffA", { "inventory.costs": true, permissions: { "inventory.costs": true } }).doc(`businesses/${A}/productCosts/${PID}`).get());
  });
});

describe("module and subscription gates", () => {
  it("Inventory module off: the owner reads nothing, quantities or costs", async () => {
    await assertFails(get("ownerOff", "inv-off", "products", PID));
    await assertFails(get("ownerOff", "inv-off", "productCosts", PID));
  });

  it("suspended: reads continue, writes never", async () => {
    const bid = STATUS_TENANTS.suspended.bid;
    await assertSucceeds(get(statusUid("owner", bid), bid, "productCosts", PID));
    await assertFails(dbAs(env, statusUid("owner", bid)).doc(`businesses/${bid}/products/${PID}`).update({ onHand: 1 }));
  });

  it("cancelled: inventory isn't export-only, so even the owner reads none of it", async () => {
    const bid = STATUS_TENANTS.cancelled.bid;
    await assertFails(get(statusUid("owner", bid), bid, "products", PID));
    await assertFails(get(statusUid("owner", bid), bid, "productCosts", PID));
  });
});

describe("Business A can never read or modify Business B inventory", () => {
  for (const uid of ["ownerA", "managerA", "staffA", "receiverA", "costStaffA"]) {
    it(`${uid}: every collection, every route`, async () => {
      const db = dbAs(env, uid);
      for (const c of [...QTY_COLLECTIONS, ...COST_COLLECTIONS, "skuIndex"]) {
        const id = c === "skuIndex" ? "RICE-25" : idFor(c);
        await assertFails(db.doc(`businesses/${B}/${c}/${id}`).get());
        await assertFails(db.collection(`businesses/${B}/${c}`).get());
        await assertFails(db.collection(`businesses/${B}/${c}`).where("productId", "==", PID).get());
        await assertFails(db.doc(`businesses/${B}/${c}/${id}`).set({ forged: true }));
        await assertFails(db.doc(`businesses/${B}/${c}/${id}`).delete());
        await assertFails(db.collectionGroup(c).get());
      }
      // Same product id, constructed path into B: still B's document, still denied.
      await assertFails(db.doc(`businesses/${B}/products/${PID}`).update({ onHand: 0 }));
    });
  }
});
