// Phase 8.5 rules: the workspace template is enforced in Firestore and
// Storage, not just in navigation. A bridal workspace reads no Distributor
// data even with a forged snapshot; stale / unknown / mismatched workspace
// snapshots deny everything module-gated; Distributor is unchanged (the
// whole existing suite runs on distributor snapshots).

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, DOC, businessDoc, createEnv, dbAs, seedMember, seedTenant } from "./fixture.js";

let env;
const W = "ws-bridal";
const DISTRIBUTOR_DATA = ["orders", "products", "inventoryTransactions", "productCosts", "payments", "orderCosts", "customers", "reports", "imports"];

// Variants of a bridal (or legacy) business document, by tenant id.
function legacy(doc) {
  delete doc.workspaceTemplateId;
  doc.entitlements.schemaVersion = 1;
  delete doc.entitlements.workspaceTemplateId;
  delete doc.entitlements.workspaceTemplateVersion;
  return doc;
}
const VARIANTS = {
  [W]: (d) => d,
  "ws-forged": (d) => ((d.entitlements.modules = { ...d.entitlements.modules, orders: true, inventory: true, payments: true }), d),
  "ws-stale": (d) => ((d.entitlements.workspaceTemplateVersion = 0), d),
  "ws-unknown": (d) => ((d.workspaceTemplateId = "florist"), (d.entitlements.workspaceTemplateId = "florist"), d),
  "ws-mismatch": (d) => ((d.workspaceTemplateId = "baby-expense"), d),
  "ws-no-business-template": (d) => (delete d.workspaceTemplateId, d),
  "ws-malformed": (d) => ((d.workspaceTemplateId = ["bridal-expense"]), d),
};
const DIST_VARIANTS = {
  // Phase 9 / 10: distributor moved to v2 then v3; older snapshots are stale.
  "ws-dist-v1-stale": (d) => ((d.entitlements.workspaceTemplateVersion = 1), d),
  "ws-dist-v2-stale": (d) => ((d.entitlements.workspaceTemplateVersion = 2), d),
  "ws-dist-v3-stale": (d) => ((d.entitlements.workspaceTemplateVersion = 3), d),
  "ws-legacy": (d) => legacy(d),
  "ws-legacy-assigned": (d) => ((legacy(d).workspaceTemplateId = "distributor"), d),
  "ws-legacy-forged": (d) => ((legacy(d).entitlements.workspaceTemplateId = "distributor"), d),
};

beforeAll(async () => {
  env = await createEnv({ storage: true });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const all = [...Object.entries(VARIANTS).map(([bid, f]) => [bid, f, "bridal-expense"]), ...Object.entries(DIST_VARIANTS).map(([bid, f]) => [bid, f, "distributor"])];
    for (const [bid, mutate, template] of all) {
      await seedTenant(db, bid, `WS ${bid}`, "active", { planId: "pro", workspaceTemplateId: template });
      await db.doc(`businesses/${bid}`).set(mutate(businessDoc(`WS ${bid}`, "active", { planId: "pro", workspaceTemplateId: template })));
      for (const role of ["owner", "manager", "staff"]) await seedMember(db, bid, `${role}@${bid}`, { role, isAccountOwner: role === "owner" });
      for (const area of ["products", "payments", "imports", "exports"]) await ctx.storage().ref(`tenants/${bid}/${area}/seed.txt`).putString(bid);
    }
  });
});
afterAll(async () => {
  await env?.cleanup();
});

const get = (uid, path) => dbAs(env, uid).doc(path).get();
const storageGet = (uid, path) => env.authenticatedContext(uid).storage().ref(path).getMetadata();

describe("bridal workspace", () => {
  for (const role of ["owner", "manager", "staff"]) {
    const uid = `${role}@${W}`;
    it(`${role}: no Distributor collection is readable, by document or by query`, async () => {
      for (const c of DISTRIBUTOR_DATA) {
        await assertFails(get(uid, `businesses/${W}/${c}/${DOC}`));
        await assertFails(dbAs(env, uid).collection(`businesses/${W}/${c}`).limit(5).get());
      }
    });

    it(`${role}: no Distributor Storage area is readable`, async () => {
      for (const area of ["products", "payments", "imports", "exports"]) await assertFails(storageGet(uid, `tenants/${W}/${area}/seed.txt`));
    });

    it(`${role}: the business itself and the dashboard documents are still readable`, async () => {
      await assertSucceeds(get(uid, `businesses/${W}`));
      await assertSucceeds(get(uid, `businesses/${W}/metrics/${DOC}`));
    });
  }

  it("owner and manager can list members (Users is core); staff can't", async () => {
    await assertSucceeds(dbAs(env, `owner@${W}`).collection(`businesses/${W}/members`).get());
    await assertSucceeds(dbAs(env, `manager@${W}`).collection(`businesses/${W}/members`).get());
    await assertFails(dbAs(env, `staff@${W}`).collection(`businesses/${W}/members`).get());
  });

  it("forged snapshot with Orders/Inventory/Payments on: still denied (the template is re-checked)", async () => {
    for (const c of ["orders", "products", "payments"]) await assertFails(get("owner@ws-forged", `businesses/ws-forged/${c}/${DOC}`));
    await assertFails(storageGet("owner@ws-forged", "tenants/ws-forged/payments/seed.txt"));
    await assertFails(storageGet("owner@ws-forged", "tenants/ws-forged/products/seed.txt"));
  });

  it("other tenants are never reachable from a bridal workspace, and vice versa", async () => {
    await assertFails(get(`owner@${W}`, `businesses/${A}/orders/${DOC}`));
    await assertFails(get("ownerA", `businesses/${W}/metrics/${DOC}`));
  });
});

describe("stale / unknown / mismatched / malformed workspace: every module read denied", () => {
  for (const bid of ["ws-stale", "ws-unknown", "ws-mismatch", "ws-no-business-template", "ws-malformed"]) {
    it(bid, async () => {
      for (const c of ["metrics", "settings"]) await assertFails(get(`owner@${bid}`, `businesses/${bid}/${c}/${DOC}`));
      await assertFails(dbAs(env, `owner@${bid}`).collection(`businesses/${bid}/members`).get());
      await assertFails(storageGet(`owner@${bid}`, `tenants/${bid}/payments/seed.txt`));
    });
  }
});

describe("template versions", () => {
  it("distributor snapshots still at v1 or v2 (before the Phase 9 / 10 recomputes) are denied now", async () => {
    for (const bid of ["ws-dist-v1-stale", "ws-dist-v2-stale", "ws-dist-v3-stale"]) {
      await assertFails(get(`owner@${bid}`, `businesses/${bid}/orders/${DOC}`));
      await assertFails(get(`owner@${bid}`, `businesses/${bid}/expenses/${DOC}`));
    }
  });
});

describe("legacy (pre-8.5) snapshots", () => {
  it("an unmigrated legacy distributor is denied (no 'missing = distributor')", async () => {
    await assertFails(get("owner@ws-legacy", `businesses/ws-legacy/orders/${DOC}`));
    await assertFails(get("owner@ws-legacy", `businesses/ws-legacy/metrics/${DOC}`));
    await assertFails(storageGet("owner@ws-legacy", "tenants/ws-legacy/products/seed.txt"));
  });

  it("legacy snapshot on a business that already has a template: denied", async () => {
    await assertFails(get("owner@ws-legacy-assigned", `businesses/ws-legacy-assigned/orders/${DOC}`));
  });

  it("legacy schemaVersion with a workspace stamped on: denied", async () => {
    await assertFails(get("owner@ws-legacy-forged", `businesses/ws-legacy-forged/orders/${DOC}`));
  });
});
