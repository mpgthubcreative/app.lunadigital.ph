// Phase 4: module entitlements in Firestore rules.
//
// Module data needs ALL of: active membership (+ subscription policy),
// the exact permission, and a valid entitlement snapshot with the module
// switched on. Expected outcomes are computed from the shared registry
// (shared/modules.js) and the real computeEntitlements / resolvePermissions,
// never hand-typed, so the matrix covers every collection x role x package.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { MODULES } from "../../shared/modules.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { computeEntitlements } from "../../shared/entitlements.js";
import { A, B, DOC, ALL_PLANS, TENANT_COLLECTIONS, businessDoc, createEnv, dbAs, seedMember, seedTenant } from "./fixture.js";

let env;

// Business packages under test (all active subscriptions).
const PACKAGES = Object.freeze({
  "ent-starter": { planId: "starter" },
  "ent-growth": { planId: "growth" },
  "ent-pro": { planId: "pro" },
  // THE scenario: Growth with Payments switched off for this business.
  // (Phase 4 used Reports; Reports is unbuilt since the Phase 8.5 cleanup.)
  "ent-no-payments": { planId: "growth", overrides: { modules: { payments: false } } },
  // Test-only plan without Payments (and the unbuilt placeholders) ...
  "ent-lite": { planId: "lite-test" },
  // ... and the same plan with Payments added back by override (add-on).
  "ent-lite-plus": { planId: "lite-test", overrides: { modules: { payments: true } } },
  // Reverse: a plan module removed by override.
  "ent-growth-minus": { planId: "growth", overrides: { modules: { inventory: false, imports: false } } },
});

const ROLES = Object.freeze({
  owner: { role: "owner", isAccountOwner: true },
  manager: { role: "manager" },
  staff: { role: "staff" },
  // Staff hold payments.view by default; noPayStaff has it revoked, and
  // costStaff is granted inventory.costs (a per-member grant).
  payStaff: { role: "staff" },
  noPayStaff: { role: "staff", overrides: { revoke: ["payments.view"] } },
  costStaff: { role: "staff", overrides: { grant: ["inventory.costs"] } },
  disabledPayStaff: { role: "staff", status: "disabled" },
});

const uidOf = (kind, bid) => `${kind}@${bid}`;

// collection -> registry module (imports/rows follows imports)
const MODULE_OF = {};
for (const mod of MODULES) for (const c of Object.keys(mod.collections)) MODULE_OF[c] = mod;

const READABLE = Object.entries(TENANT_COLLECTIONS).filter(([, permission]) => permission !== null);

function expectedAccess(kind, pkg, collection) {
  const spec = ROLES[kind];
  const permission = TENANT_COLLECTIONS[collection];
  if (!permission || spec.status === "disabled") return false;
  const perms = resolvePermissions(spec.role, spec.overrides || {});
  const ent = computeEntitlements(ALL_PLANS[pkg.planId], pkg.overrides || {}, "distributor");
  return perms[permission] === true && ent.modules[MODULE_OF[collection].id] === true;
}

// Malformed snapshots: each breaks a valid Growth business document.
const BROKEN = Object.freeze({
  "missing snapshot": (b) => delete b.entitlements,
  "snapshot is a string": (b) => (b.entitlements = "all"),
  "unknown plan (no plans/ doc)": (b) => {
    b.subscription.planId = "platinum";
    b.entitlements.planId = "platinum";
  },
  "stale: subscription moved to pro, snapshot still growth": (b) => (b.subscription.planId = "pro"),
  "subscription.planId missing": (b) => delete b.subscription.planId,
  "invalid planId format": (b) => {
    b.subscription.planId = "Growth";
    b.entitlements.planId = "Growth";
  },
  "schemaVersion missing": (b) => delete b.entitlements.schemaVersion,
  "schemaVersion 3 (future)": (b) => (b.entitlements.schemaVersion = 3),
  "workspace version stale": (b) => (b.entitlements.workspaceTemplateVersion = 0),
  "workspace missing from snapshot": (b) => delete b.entitlements.workspaceTemplateId,
  "unbuilt module enabled (suppliers = true)": (b) => (b.entitlements.modules.suppliers = true),
  "modules not a map": (b) => (b.entitlements.modules = ["orders", "reports"]),
  "reports = 'true' (string)": (b) => (b.entitlements.modules.reports = "true"),
  "orders = 1": (b) => (b.entitlements.modules.orders = 1),
  "another module non-boolean (suppliers = 'yes')": (b) => (b.entitlements.modules.suppliers = "yes"),
  "unknown module key": (b) => (b.entitlements.modules.teleport = true),
  "module key missing": (b) => delete b.entitlements.modules.payments,
  "core module off (dashboard = false)": (b) => (b.entitlements.modules.dashboard = false),
  "limits not a map": (b) => (b.entitlements.limits = 100),
  "limit is a string": (b) => (b.entitlements.limits.users = "5"),
  "limit negative": (b) => (b.entitlements.limits.ordersPerMonth = -1),
  "limit fractional": (b) => (b.entitlements.limits.storageBytes = 1.5),
  "limit key missing": (b) => delete b.entitlements.limits.importsPerMonth,
  "unknown limit key": (b) => (b.entitlements.limits.galaxies = 1),
  "features not a map": (b) => (b.entitlements.features = true),
  "invalid feature value": (b) => (b.entitlements.features.support = "platinum"),
  "non-boolean feature": (b) => (b.entitlements.features.googleSheets = "yes"),
  "unknown feature key": (b) => (b.entitlements.features.teleport = true),
  "feature key missing": (b) => delete b.entitlements.features.reportsLevel,
});

const brokenBid = (index) => `bad-${String(index).padStart(2, "0")}`;

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [bid, pkg] of Object.entries(PACKAGES)) {
      await seedTenant(db, bid, bid, "active", pkg);
      for (const [kind, spec] of Object.entries(ROLES)) await seedMember(db, bid, uidOf(kind, bid), spec);
    }
    let i = 0;
    for (const breakIt of Object.values(BROKEN)) {
      const bid = brokenBid(i++);
      await seedTenant(db, bid, bid, "active", { planId: "growth" });
      const doc = businessDoc(bid, "active", { planId: "growth" });
      breakIt(doc);
      await db.doc(`businesses/${bid}`).set(doc);
      for (const kind of ["owner", "payStaff"]) await seedMember(db, bid, uidOf(kind, bid), ROLES[kind]);
    }
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("THE scenario: staff with payments.view, Payments disabled for the business", () => {
  const bid = "ent-no-payments";

  it("Firestore DENIES get, list and query of payments", async () => {
    const db = dbAs(env, uidOf("payStaff", bid));
    await assertFails(db.doc(`businesses/${bid}/payments/${DOC}`).get());
    await assertFails(db.collection(`businesses/${bid}/payments`).get());
    await assertFails(db.collection(`businesses/${bid}/payments`).where("tenant", "==", bid).limit(10).get());
  });

  it("the same user reads payments on a package that includes them", async () => {
    await assertSucceeds(dbAs(env, uidOf("payStaff", "ent-growth")).doc(`businesses/ent-growth/payments/${DOC}`).get());
  });

  it("the owner (every permission) is denied too", async () => {
    await assertFails(dbAs(env, uidOf("owner", bid)).doc(`businesses/${bid}/payments/${DOC}`).get());
  });

  it("other modules on the same package keep working", async () => {
    await assertSucceeds(dbAs(env, uidOf("payStaff", bid)).doc(`businesses/${bid}/orders/${DOC}`).get());
  });
});

describe("Imports (built in Phase 12) follows plan + permission", () => {
  it("the owner of a Pro business reads import jobs and rows", async () => {
    await assertSucceeds(dbAs(env, uidOf("owner", "ent-pro")).doc(`businesses/ent-pro/imports/${DOC}`).get());
    await assertSucceeds(dbAs(env, uidOf("owner", "ent-pro")).collection(`businesses/ent-pro/imports/${DOC}/rows`).get());
  });
});

describe("membership AND permission AND module", () => {
  const payment = (bid) => `businesses/${bid}/payments/${DOC}`;

  it("active membership + permission + module enabled -> ALLOW", async () => {
    await assertSucceeds(dbAs(env, uidOf("payStaff", "ent-growth")).doc(payment("ent-growth")).get());
  });

  it("active membership + permission + module disabled -> DENY", async () => {
    await assertFails(dbAs(env, uidOf("payStaff", "ent-no-payments")).doc(payment("ent-no-payments")).get());
  });

  it("active membership + module enabled + permission missing -> DENY", async () => {
    await assertFails(dbAs(env, uidOf("noPayStaff", "ent-growth")).doc(payment("ent-growth")).get());
  });

  it("a per-member grant works (staff + inventory.costs reads product costs)", async () => {
    await assertSucceeds(dbAs(env, uidOf("costStaff", "ent-growth")).doc(`businesses/ent-growth/productCosts/${DOC}`).get());
    await assertFails(dbAs(env, uidOf("staff", "ent-growth")).doc(`businesses/ent-growth/productCosts/${DOC}`).get());
  });

  it("permission + module enabled + disabled membership -> DENY", async () => {
    await assertFails(dbAs(env, uidOf("disabledPayStaff", "ent-growth")).doc(payment("ent-growth")).get());
  });
});

describe("package x role x collection matrix", () => {
  for (const [bid, pkg] of Object.entries(PACKAGES)) {
    for (const kind of Object.keys(ROLES)) {
      for (const [collection] of READABLE) {
        const allowed = expectedAccess(kind, pkg, collection);
        it(`${bid} / ${kind} ${allowed ? "CAN" : "cannot"} read ${collection}`, async () => {
          const db = dbAs(env, uidOf(kind, bid));
          const get = db.doc(`businesses/${bid}/${collection}/${DOC}`).get();
          const list = db.collection(`businesses/${bid}/${collection}`).limit(5).get();
          if (allowed) {
            await assertSucceeds(get);
            await assertSucceeds(list);
          } else {
            await assertFails(get);
            await assertFails(list);
          }
        });
      }
    }
  }
});

describe("plan differences and overrides", () => {
  it("Starter, Growth and Pro all include Payments today (seeded definitions)", async () => {
    for (const bid of ["ent-starter", "ent-growth", "ent-pro"]) {
      await assertSucceeds(dbAs(env, uidOf("manager", bid)).doc(`businesses/${bid}/payments/${DOC}`).get());
    }
  });

  it("plan without Payments denies it; an add-on override allows it (within the template)", async () => {
    await assertFails(dbAs(env, uidOf("manager", "ent-lite")).doc(`businesses/ent-lite/payments/${DOC}`).get());
    await assertSucceeds(dbAs(env, uidOf("manager", "ent-lite-plus")).doc(`businesses/ent-lite-plus/payments/${DOC}`).get());
    // The add-on covers Payments only; unbuilt modules stay off.
    await assertFails(dbAs(env, uidOf("manager", "ent-lite-plus")).doc(`businesses/ent-lite-plus/imports/${DOC}`).get());
    await assertFails(dbAs(env, uidOf("manager", "ent-lite-plus")).doc(`businesses/ent-lite-plus/customers/${DOC}`).get());
  });

  it("override removing plan modules denies them, including import rows", async () => {
    const db = dbAs(env, uidOf("owner", "ent-growth-minus"));
    await assertFails(db.doc(`businesses/ent-growth-minus/products/${DOC}`).get());
    await assertFails(db.collection(`businesses/ent-growth-minus/inventoryTransactions`).get());
    await assertFails(db.collection(`businesses/ent-growth-minus/imports/${DOC}/rows`).get());
    await assertSucceeds(db.doc(`businesses/ent-growth-minus/orders/${DOC}`).get());
  });

  it("core modules (team list, settings, dashboard metrics) work on every package", async () => {
    for (const bid of Object.keys(PACKAGES)) {
      const db = dbAs(env, uidOf("owner", bid));
      await assertSucceeds(db.collection(`businesses/${bid}/members`).get());
      await assertSucceeds(db.doc(`businesses/${bid}/settings/${DOC}`).get());
      await assertSucceeds(db.doc(`businesses/${bid}/metrics/${DOC}`).get());
    }
  });
});

describe("malformed entitlement snapshots fail closed", () => {
  Object.keys(BROKEN).forEach((label, index) => {
    const bid = brokenBid(index);
    it(`${label}: no module data for owner or staff`, async () => {
      for (const kind of ["owner", "payStaff"]) {
        const db = dbAs(env, uidOf(kind, bid));
        for (const [collection] of READABLE) {
          await assertFails(db.doc(`businesses/${bid}/${collection}/${DOC}`).get());
          await assertFails(db.collection(`businesses/${bid}/${collection}`).get());
        }
        await assertFails(db.collection(`businesses/${bid}/members`).get());
      }
    });
  });

  it("repairing the snapshot restores access (the snapshot was the only cause)", async () => {
    const bid = brokenBid(0);
    const db = dbAs(env, uidOf("owner", bid));
    await assertFails(db.doc(`businesses/${bid}/orders/${DOC}`).get());
    await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`businesses/${bid}`).set(businessDoc(bid, "active", { planId: "growth" })));
    await assertSucceeds(db.doc(`businesses/${bid}/orders/${DOC}`).get());
  });

  it("a plan change without recompute denies until the snapshot is recomputed", async () => {
    const bid = "ent-growth";
    const db = dbAs(env, uidOf("manager", bid));
    const set = (doc) => env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`businesses/${bid}`).set(doc));
    const stale = businessDoc(bid, "active", { planId: "growth" });
    stale.subscription.planId = "lite-test";
    await set(stale);
    await assertFails(db.doc(`businesses/${bid}/orders/${DOC}`).get());
    await set(businessDoc(bid, "active", { planId: "lite-test" }));
    await assertSucceeds(db.doc(`businesses/${bid}/orders/${DOC}`).get());
    await assertFails(db.doc(`businesses/${bid}/payments/${DOC}`).get());
    await set(businessDoc(bid, "active", { planId: "growth" }));
  });
});

describe("browser can't change its own package", () => {
  for (const kind of ["owner", "manager"]) {
    it(`${kind} cannot write entitlements, overrides, plan or plans/`, async () => {
      const bid = "ent-no-payments";
      const db = dbAs(env, uidOf(kind, bid));
      const ref = db.doc(`businesses/${bid}`);
      await assertFails(ref.update({ "entitlements.modules.payments": true }));
      await assertFails(ref.update({ moduleOverrides: { payments: true } }));
      await assertFails(ref.update({ "subscription.planId": "pro" }));
      await assertFails(ref.set({ entitlements: { modules: { reports: true } } }, { merge: true }));
      await assertFails(db.doc("plans/growth").update({ "modules.reports": true }));
      await assertFails(db.doc("plans/mine").set({ id: "mine", modules: { reports: true } }));
      await assertFails(db.doc(`businesses/${bid}/settings/package`).set({ reports: true }));
    });
  }

  it("forged plan / module claims on the token grant nothing", async () => {
    const bid = "ent-no-payments";
    const db = dbAs(env, uidOf("payStaff", bid), { plan: "pro", planId: "pro", modules: { payments: true }, entitlements: { payments: true } });
    await assertFails(db.doc(`businesses/${bid}/payments/${DOC}`).get());
  });
});

describe("entitlements never open a path across tenants", () => {
  it("A users can't read B (Pro, every module) in any module collection", async () => {
    for (const uid of ["ownerA", "managerA", "staffA"]) {
      const db = dbAs(env, uid);
      for (const [collection] of READABLE) {
        await assertFails(db.doc(`businesses/${B}/${collection}/${DOC}`).get());
        await assertFails(db.collection(`businesses/${B}/${collection}`).get());
        await assertFails(db.collection(`businesses/${B}/${collection}`).where("tenant", "==", B).get());
      }
    }
  });

  it("members of packaged test tenants can't read A, B or each other", async () => {
    for (const bid of Object.keys(PACKAGES)) {
      const db = dbAs(env, uidOf("owner", bid));
      for (const target of [A, B, ...Object.keys(PACKAGES).filter((other) => other !== bid)]) {
        await assertFails(db.doc(`businesses/${target}/orders/${DOC}`).get());
        await assertFails(db.doc(`businesses/${target}/payments/${DOC}`).get());
      }
    }
  });

  it("Payments off in my business does not let me read Payments somewhere it's on", async () => {
    const db = dbAs(env, uidOf("payStaff", "ent-no-payments"));
    for (const bid of ["ent-growth", "ent-pro", B]) await assertFails(db.doc(`businesses/${bid}/payments/${DOC}`).get());
  });

  it("collection-group queries stay refused", async () => {
    const db = dbAs(env, uidOf("owner", "ent-pro"));
    for (const name of ["reports", "orders", "members"]) await assertFails(db.collectionGroup(name).get());
  });
});
