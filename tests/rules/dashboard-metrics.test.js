// Phase 5 rules: operational metrics (dashboard.view) vs financial metrics
// (dashboard.financials), the unbuilt Expenses module, and the
// pre-Expenses snapshot migration. Generic coverage (every role, status,
// write type, collection-group query) comes from the Phase 3/4 suites,
// which include metrics, financialMetrics and expenses via TENANT_COLLECTIONS.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, B, businessDoc, createEnv, dbAs, seedMember } from "./fixture.js";

let env;
const IDS = ["2026-10-08", "2026-10", "current"];

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [A, B]) {
      for (const id of IDS) {
        await db.doc(`businesses/${bid}/metrics/${id}`).set({ schemaVersion: 1, orderCount: 3 });
        await db.doc(`businesses/${bid}/financialMetrics/${id}`).set({ schemaVersion: 1, grossSales: 100000, cogs: 60000 });
      }
      await db.doc(`businesses/${bid}/expenses/rent-oct`).set({ amount: 2500000, categoryId: "rent" });
    }
    await seedMember(db, A, "finStaffA", { role: "staff", overrides: { grant: ["dashboard.financials"] } });
    await seedMember(db, A, "noFinManagerA", { role: "manager", overrides: { revoke: ["dashboard.financials"] } });
    // A business whose snapshot predates the Expenses module (12 module keys).
    const old = businessDoc("Old snapshot", "active", { planId: "growth" });
    delete old.entitlements.modules.expenses;
    await db.doc("businesses/old-snapshot").set(old);
    await seedMember(db, "old-snapshot", "ownerOld", { role: "owner", isAccountOwner: true });
    await db.doc("businesses/old-snapshot/metrics/current").set({ orderCount: 1 });
    await db.doc("businesses/old-snapshot/financialMetrics/current").set({ grossSales: 1 });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("operational metrics: dashboard.view", () => {
  for (const uid of ["ownerA", "managerA", "staffA"]) {
    it(`${uid} reads day, month and current metrics`, async () => {
      for (const id of IDS) await assertSucceeds(dbAs(env, uid).doc(`businesses/${A}/metrics/${id}`).get());
    });
  }
});

describe("financial metrics: dashboard.financials", () => {
  for (const uid of ["ownerA", "managerA", "finStaffA"]) {
    it(`${uid} reads day, month and current financial metrics`, async () => {
      for (const id of IDS) await assertSucceeds(dbAs(env, uid).doc(`businesses/${A}/financialMetrics/${id}`).get());
    });
  }

  for (const uid of ["staffA", "noFinManagerA", "disabledA", "outsider"]) {
    it(`${uid} is refused every financial metric document and the list`, async () => {
      const db = dbAs(env, uid);
      for (const id of IDS) await assertFails(db.doc(`businesses/${A}/financialMetrics/${id}`).get());
      await assertFails(db.collection(`businesses/${A}/financialMetrics`).get());
    });
  }

  it("staff can read operational metrics but not the money beside them", async () => {
    const db = dbAs(env, "staffA");
    await assertSucceeds(db.doc(`businesses/${A}/metrics/2026-10-08`).get());
    await assertFails(db.doc(`businesses/${A}/financialMetrics/2026-10-08`).get());
  });
});

describe("cross tenant", () => {
  for (const uid of ["ownerA", "managerA", "finStaffA"]) {
    it(`${uid} can't read B's metrics or financial metrics`, async () => {
      const db = dbAs(env, uid);
      for (const id of IDS) {
        await assertFails(db.doc(`businesses/${B}/metrics/${id}`).get());
        await assertFails(db.doc(`businesses/${B}/financialMetrics/${id}`).get());
      }
      await assertFails(db.collectionGroup("financialMetrics").get());
      await assertFails(db.collectionGroup("metrics").get());
    });
  }
});

describe("Expenses (approved, not built)", () => {
  it("nobody reads expenses, even the owner with the module entitled", async () => {
    for (const uid of ["ownerA", "managerA", "finStaffA", "staffA"]) {
      const db = dbAs(env, uid);
      await assertFails(db.doc(`businesses/${A}/expenses/rent-oct`).get());
      await assertFails(db.collection(`businesses/${A}/expenses`).get());
      await assertFails(db.collection(`businesses/${A}/expenses`).where("categoryId", "==", "rent").get());
    }
  });

  it("nobody writes expenses", async () => {
    const db = dbAs(env, "ownerA");
    await assertFails(db.doc(`businesses/${A}/expenses/new`).set({ amount: 1 }));
    await assertFails(db.doc(`businesses/${A}/expenses/rent-oct`).update({ amount: 0 }));
    await assertFails(db.doc(`businesses/${A}/expenses/rent-oct`).delete());
  });

  it("forged expense claims grant nothing", async () => {
    await assertFails(dbAs(env, "staffA", { "expenses.view": true, modules: { expenses: true } }).doc(`businesses/${A}/expenses/rent-oct`).get());
  });

  it("A can't reach B's expenses", async () => {
    await assertFails(dbAs(env, "ownerA").doc(`businesses/${B}/expenses/rent-oct`).get());
    await assertFails(dbAs(env, "ownerA").collectionGroup("expenses").get());
  });
});

describe("snapshot from before Expenses existed", () => {
  it("is invalid: every module read, including the dashboard, is denied until recomputed", async () => {
    const db = dbAs(env, "ownerOld");
    await assertFails(db.doc("businesses/old-snapshot/metrics/current").get());
    await assertFails(db.doc("businesses/old-snapshot/financialMetrics/current").get());
    await assertFails(db.collection("businesses/old-snapshot/members").get());
  });

  it("recomputing (13 module keys) restores access", async () => {
    await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc("businesses/old-snapshot").set(businessDoc("Old snapshot", "active", { planId: "growth" })));
    await assertSucceeds(dbAs(env, "ownerOld").doc("businesses/old-snapshot/metrics/current").get());
  });
});
