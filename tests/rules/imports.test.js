// Phase 12 rules: Import History (imports/{id} and its row chunks) is
// readable with imports.run on a Distributor v5 workspace; every write is
// server-only; no other tenant and no non-Distributor workspace reads it.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, B, businessDoc, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const JOB = "jobAAAAAAAAAAAAAAAAA";

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [A, B]) {
      await db.doc(`businesses/${bid}/imports/${JOB}`).set({ type: "products", status: "completed", createdAt: new Date() });
      await db.doc(`businesses/${bid}/imports/${JOB}/rows/000`).set({ index: 0, rows: [{ n: 2, values: { sku: "A" } }], results: {} });
    }
    await db.doc("businesses/imp-bridal").set(businessDoc("Wedding", "active", { planId: "pro", workspaceTemplateId: "bridal-expense" }));
    await seedMember(db, "imp-bridal", "ownerImpBridal", { role: "owner", isAccountOwner: true });
    await db.doc(`businesses/imp-bridal/imports/${JOB}`).set({ type: "products" });
    await db.doc("businesses/imp-off").set(businessDoc("Imports off", "active", { planId: "growth", overrides: { modules: { imports: false } } }));
    await seedMember(db, "imp-off", "ownerImpOff", { role: "owner", isAccountOwner: true });
    await db.doc(`businesses/imp-off/imports/${JOB}`).set({ type: "products" });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("Import History", () => {
  for (const uid of ["ownerA", "managerA"]) {
    it(`${uid} reads A's imports and their rows (the page's queries)`, async () => {
      const db = dbAs(env, uid);
      await assertSucceeds(db.collection(`businesses/${A}/imports`).orderBy("createdAt", "desc").limit(25).get());
      await assertSucceeds(db.collection(`businesses/${A}/imports/${JOB}/rows`).get());
    });
  }

  it("staff (no imports.run) can't", async () => {
    await assertFails(dbAs(env, "staffA").doc(`businesses/${A}/imports/${JOB}`).get());
    await assertFails(dbAs(env, "staffA").collection(`businesses/${A}/imports/${JOB}/rows`).get());
  });

  for (const uid of ["ownerA", "managerA", "staffA"]) {
    it(`${uid}: no browser writes, nothing of B's`, async () => {
      const db = dbAs(env, uid);
      await assertFails(db.doc(`businesses/${A}/imports/newJob00000000000001`).set({ type: "products", status: "completed" }));
      await assertFails(db.doc(`businesses/${A}/imports/${JOB}`).update({ status: "previewed" }));
      await assertFails(db.doc(`businesses/${A}/imports/${JOB}/rows/000`).update({ "results.0": { outcome: "created" } }));
      await assertFails(db.doc(`businesses/${A}/imports/${JOB}`).delete());
      await assertFails(db.doc(`businesses/${B}/imports/${JOB}`).get());
      await assertFails(db.collection(`businesses/${B}/imports/${JOB}/rows`).get());
      await assertFails(db.doc(`businesses/${A}/usage/2026-10`).set({ excelImports: 0 }, { merge: true }));
    });
  }

  it("Imports off, bridal workspaces, outsiders and collection groups: nothing", async () => {
    await assertFails(dbAs(env, "ownerImpOff").doc(`businesses/imp-off/imports/${JOB}`).get());
    await assertFails(dbAs(env, "ownerImpBridal").doc(`businesses/imp-bridal/imports/${JOB}`).get());
    await assertFails(dbAnon(env).doc(`businesses/${A}/imports/${JOB}`).get());
    await assertFails(dbAs(env, "ownerA").collectionGroup("rows").get());
    await assertFails(dbAs(env, "ownerA").collectionGroup("imports").get());
  });
});
