// Phase 11 rules: report breakdowns (reportRollups) are server-only, so
// money stays behind GET /api/reports + dashboard.financials; the summary
// documents keep their Phase 5 split (metrics: dashboard.view,
// financialMetrics: dashboard.financials); non-Distributor workspaces and
// other tenants get nothing.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, B, businessDoc, createEnv, dbAs, seedMember } from "./fixture.js";

let env;

beforeAll(async () => {
  env = await createEnv({ storage: true });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [A, B]) {
      await db.doc(`businesses/${bid}/reportRollups/2026-10-08`).set({ period: "day", products: { p1: { qty: 1000, netSales: 100000, cogs: 60000 } } });
      await db.doc(`businesses/${bid}/reportRollups/2026-10`).set({ period: "month" });
    }
    await seedMember(db, A, "reportStaffA", { role: "staff", overrides: { grant: ["reports.view"] } });
    await db.doc("businesses/rep-bridal").set(businessDoc("Wedding", "active", { planId: "pro", workspaceTemplateId: "bridal-expense" }));
    await seedMember(db, "rep-bridal", "ownerRepBridal", { role: "owner", isAccountOwner: true });
    await ctx.storage().ref("tenants/rep-bridal/exports/seed.txt").putString("x");
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("report rollups are server-only", () => {
  for (const uid of ["ownerA", "managerA", "staffA", "reportStaffA"]) {
    it(`${uid} can't read, list or write A's rollups`, async () => {
      const db = dbAs(env, uid);
      await assertFails(db.doc(`businesses/${A}/reportRollups/2026-10-08`).get());
      await assertFails(db.collection(`businesses/${A}/reportRollups`).get());
      await assertFails(db.doc(`businesses/${A}/reportRollups/2026-10-08`).set({ products: {} }));
      await assertFails(db.doc(`businesses/${B}/reportRollups/2026-10-08`).get());
    });
  }

  it("collection-group queries over rollups are refused", async () => {
    await assertFails(dbAs(env, "ownerA").collectionGroup("reportRollups").get());
  });
});

describe("summary documents keep the financial split", () => {
  it("a staff member with reports.view only can't read financialMetrics", async () => {
    await assertSucceeds(dbAs(env, "reportStaffA").doc(`businesses/${A}/metrics/seed-1`).get());
    await assertFails(dbAs(env, "reportStaffA").doc(`businesses/${A}/financialMetrics/seed-1`).get());
  });
});

describe("Reports module areas", () => {
  it("owners read the Reports collection and exports area (reports.view / reports.export); plain staff don't", async () => {
    await assertSucceeds(dbAs(env, "ownerA").doc(`businesses/${A}/reports/seed-1`).get());
    await assertFails(dbAs(env, "staffA").doc(`businesses/${A}/reports/seed-1`).get());
    await assertSucceeds(env.authenticatedContext("ownerA").storage().ref(`tenants/${A}/exports/seed.txt`).getMetadata());
    await assertFails(env.authenticatedContext("staffA").storage().ref(`tenants/${A}/exports/seed.txt`).getMetadata());
  });

  it("a bridal workspace gets no Reports data", async () => {
    await assertFails(dbAs(env, "ownerRepBridal").doc("businesses/rep-bridal/reports/seed-1").get());
    await assertFails(env.authenticatedContext("ownerRepBridal").storage().ref("tenants/rep-bridal/exports/seed.txt").getMetadata());
  });
});
