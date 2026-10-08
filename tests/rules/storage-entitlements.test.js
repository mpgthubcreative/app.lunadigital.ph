// Phase 4: module entitlements in Storage rules. Each area belongs to a
// module (shared/modules.js `storage`); a file is readable only with an
// active membership, the area's permission AND the module enabled in a
// valid snapshot.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { MODULES } from "../../shared/modules.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { computeEntitlements } from "../../shared/entitlements.js";
import { ALL_PLANS, B, STORAGE_AREAS, businessDoc, createEnv, seedMember, seedTenant } from "./fixture.js";

let env;

const PACKAGES = Object.freeze({
  "st-growth": { planId: "growth" },
  // Phase 4 used Reports/exports; Reports and Imports are unbuilt since the
  // Phase 8.5 cleanup, so the scenario uses Payments (payments area).
  "st-no-payments": { planId: "growth", overrides: { modules: { payments: false } } },
  "st-lite": { planId: "lite-test" },
  "st-lite-plus": { planId: "lite-test", overrides: { modules: { payments: true } } },
  "st-growth-minus": { planId: "growth", overrides: { modules: { inventory: false, payments: false } } },
});

const BROKEN = Object.freeze({
  "st-bad-missing": (b) => delete b.entitlements,
  "st-bad-string-flag": (b) => (b.entitlements.modules.reports = "true"),
  "st-bad-stale": (b) => (b.subscription.planId = "pro"),
  "st-bad-limits": (b) => (b.entitlements.limits.users = "5"),
  "st-bad-feature": (b) => (b.entitlements.features.support = "gold"),
  "st-bad-unbuilt-on": (b) => (b.entitlements.modules.imports = true),
});

const ROLES = Object.freeze({
  owner: { role: "owner", isAccountOwner: true },
  staff: { role: "staff" },
  exportStaff: { role: "staff", overrides: { grant: ["reports.view", "reports.export"] } },
});

const uidOf = (kind, bid) => `${kind}@${bid}`;
const moduleOfArea = {};
for (const mod of MODULES) for (const area of Object.keys(mod.storage)) moduleOfArea[area] = mod.id;
const file = (bid, area) => `tenants/${bid}/${area}/seed.txt`;
const storageAs = (uid, claims) => env.authenticatedContext(uid, claims).storage();

beforeAll(async () => {
  env = await createEnv({ storage: true });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const storage = ctx.storage();
    const all = [...Object.keys(PACKAGES), ...Object.keys(BROKEN)];
    for (const bid of all) {
      const pkg = PACKAGES[bid] || { planId: "growth" };
      await seedTenant(db, bid, bid, "active", pkg);
      if (BROKEN[bid]) {
        const doc = businessDoc(bid, "active", pkg);
        BROKEN[bid](doc);
        await db.doc(`businesses/${bid}`).set(doc);
      }
      for (const [kind, spec] of Object.entries(ROLES)) await seedMember(db, bid, uidOf(kind, bid), spec);
      for (const area of Object.keys(STORAGE_AREAS)) await storage.ref(file(bid, area)).putString(`${bid}-${area}`);
    }
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("THE scenario in Storage: payments.view, Payments off", () => {
  it("payment proofs are refused when Payments is disabled, allowed when it's on", async () => {
    await assertFails(storageAs(uidOf("staff", "st-no-payments")).ref(file("st-no-payments", "payments")).getMetadata());
    await assertFails(storageAs(uidOf("owner", "st-no-payments")).ref(file("st-no-payments", "payments")).getDownloadURL());
    await assertSucceeds(storageAs(uidOf("staff", "st-growth")).ref(file("st-growth", "payments")).getMetadata());
  });

  it("unbuilt areas (exports = Reports, imports) are refused even with the permissions", async () => {
    for (const area of ["exports", "imports"]) await assertFails(storageAs(uidOf("exportStaff", "st-growth")).ref(file("st-growth", area)).getMetadata());
    for (const area of ["exports", "imports"]) await assertFails(storageAs(uidOf("owner", "st-growth")).ref(file("st-growth", area)).getMetadata());
  });
});

describe("package x role x area matrix", () => {
  for (const [bid, pkg] of Object.entries(PACKAGES)) {
    const ent = computeEntitlements(ALL_PLANS[pkg.planId], pkg.overrides || {}, "distributor");
    for (const [kind, spec] of Object.entries(ROLES)) {
      const perms = resolvePermissions(spec.role, spec.overrides || {});
      for (const [area, permission] of Object.entries(STORAGE_AREAS)) {
        const allowed = perms[permission] === true && ent.modules[moduleOfArea[area]] === true;
        it(`${bid} / ${kind} ${allowed ? "CAN" : "cannot"} read ${area}`, async () => {
          const read = storageAs(uidOf(kind, bid)).ref(file(bid, area)).getMetadata();
          if (allowed) await assertSucceeds(read);
          else await assertFails(read);
        });
      }
    }
  }
});

describe("malformed snapshots fail closed in Storage", () => {
  for (const bid of Object.keys(BROKEN)) {
    it(`${bid}: owner reads no area`, async () => {
      for (const area of Object.keys(STORAGE_AREAS)) await assertFails(storageAs(uidOf("owner", bid)).ref(file(bid, area)).getMetadata());
    });
  }
});

describe("no new paths across tenants or into writes", () => {
  it("owners of packaged tenants can't read B or each other's files", async () => {
    for (const bid of Object.keys(PACKAGES)) {
      for (const target of [B, ...Object.keys(PACKAGES).filter((t) => t !== bid)]) {
        for (const area of Object.keys(STORAGE_AREAS)) await assertFails(storageAs(uidOf("owner", bid)).ref(file(target, area)).getMetadata());
      }
    }
  });

  it("an enabled module still allows no uploads", async () => {
    for (const area of Object.keys(STORAGE_AREAS)) {
      await assertFails(storageAs(uidOf("owner", "st-growth")).ref(`tenants/st-growth/${area}/new.txt`).putString("x"));
    }
  });

  it("forged module claims grant nothing", async () => {
    await assertFails(storageAs(uidOf("staff", "st-no-payments"), { modules: { payments: true }, plan: "pro" }).ref(file("st-no-payments", "payments")).getMetadata());
  });
});
