// Phase 17 rules: operator data is server-only. operators/{uid},
// provisioning/{bid} and platformAudit are never readable or writable from
// a browser - not by a business Owner, not even by the operator themselves
// (the console reads everything through the operator API). Tenant
// configuration is readable like other settings and never browser-writable.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, createEnv, dbAs, dbAnon, seedWorld } from "./fixture.js";

let env;
beforeAll(async () => {
  env = await createEnv();
  await seedWorld(env);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc("operators/opsUid").set({ email: "ops@luna.test", role: "superadmin", status: "active" });
    await db.doc("operators/ownerA").set({ email: "x", role: "superadmin", status: "active" });
    await db.doc(`provisioning/${A}`).set({ status: "complete" });
    await db.doc("platformAudit/a1").set({ type: "business.created", businessId: A });
    await db.doc(`businesses/${A}/settings/tenantConfig`).set({ version: 1, terminology: { customer: "dealer" } });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("operator data is server-only", () => {
  for (const uid of ["opsUid", "ownerA", "managerA", "staffA"]) {
    it(`${uid}: can't read or write operators, provisioning or the platform audit`, async () => {
      const db = dbAs(env, uid);
      for (const p of ["operators/opsUid", `operators/${uid}`, `provisioning/${A}`, "platformAudit/a1"]) {
        await assertFails(db.doc(p).get());
        await assertFails(db.doc(p).set({ role: "superadmin", status: "active" }));
      }
      for (const c of ["operators", "provisioning", "platformAudit", "businesses"]) await assertFails(db.collection(c).get());
    });
  }
  it("signed out: nothing", async () => {
    for (const p of ["operators/opsUid", `provisioning/${A}`, "platformAudit/a1"]) await assertFails(dbAnon(env).doc(p).get());
  });
});

describe("tenant configuration", () => {
  it("readable with settings.view (Owner / Manager), not by Staff; never browser-writable", async () => {
    await assertSucceeds(dbAs(env, "ownerA").doc(`businesses/${A}/settings/tenantConfig`).get());
    await assertSucceeds(dbAs(env, "managerA").doc(`businesses/${A}/settings/tenantConfig`).get());
    await assertFails(dbAs(env, "staffA").doc(`businesses/${A}/settings/tenantConfig`).get());
    await assertFails(dbAs(env, "ownerA").doc(`businesses/${A}/settings/tenantConfig`).set({ terminology: { customer: "<b>" } }));
  });
});
