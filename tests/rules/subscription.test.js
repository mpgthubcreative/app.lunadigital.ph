// Subscription states and owner protection.
//
// Expected outcomes are computed from the SERVER's policy code
// (shared/subscription.js accessPolicy + shared/tenancy.js
// effectivePermissions, with the ownerOnly rule from tenant.js), so this
// suite also proves the rules and /api/session agree.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { DOC, STATUS_TENANTS, STATUS_ROLES, TENANT_COLLECTIONS, createEnv, dbAs, statusUid } from "./fixture.js";
import { accessPolicy } from "../../shared/subscription.js";
import { effectivePermissions } from "../../shared/tenancy.js";
import { resolvePermissions } from "../../shared/permissions.js";

let env;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(async () => {
  await env?.cleanup();
});

function serverView(status, spec) {
  const policy = accessPolicy(status);
  const canEnter = policy.canRead && (!policy.ownerOnly || spec.isAccountOwner === true);
  return { canEnter, permissions: canEnter ? effectivePermissions(resolvePermissions(spec.role), policy) : {} };
}

describe("server policy sanity (what the rules are checked against)", () => {
  it("matches the approved subscription table", () => {
    expect(serverView("active", STATUS_ROLES.staff).canEnter).toBe(true);
    expect(serverView("past_due", STATUS_ROLES.staff).canEnter).toBe(true);
    expect(serverView("suspended", STATUS_ROLES.staff).canEnter).toBe(true);
    expect(serverView("cancelled", STATUS_ROLES.staff).canEnter).toBe(false);
    expect(serverView("cancelled", STATUS_ROLES.owner).canEnter).toBe(true);
    expect(serverView("cancelled", STATUS_ROLES.owner).permissions["orders.view"]).toBeUndefined();
    expect(serverView("frozen", STATUS_ROLES.owner).canEnter).toBe(false);
    expect(serverView(undefined, STATUS_ROLES.owner).canEnter).toBe(false);
  });
});

for (const [label, { bid, status }] of Object.entries(STATUS_TENANTS)) {
  describe(`subscription ${label} (${JSON.stringify(status ?? null)})`, () => {
    for (const [kind, spec] of Object.entries(STATUS_ROLES)) {
      const uid = statusUid(kind, bid);
      const expected = serverView(status, spec);

      it(`${kind}: business document ${expected.canEnter ? "readable" : "refused"}`, async () => {
        const read = dbAs(env, uid).doc(`businesses/${bid}`).get();
        if (expected.canEnter) await assertSucceeds(read);
        else await assertFails(read);
      });

      it(`${kind}: every collection matches the server's effective permissions`, async () => {
        const db = dbAs(env, uid);
        for (const [collection, permission] of Object.entries(TENANT_COLLECTIONS)) {
          const allowed = permission !== null && expected.permissions[permission] === true;
          const read = db.doc(`businesses/${bid}/${collection}/${DOC}`).get();
          const list = db.collection(`businesses/${bid}/${collection}`).get();
          if (allowed) {
            await assertSucceeds(read);
            await assertSucceeds(list);
          } else {
            await assertFails(read);
            await assertFails(list);
          }
        }
      });

      it(`${kind}: writes refused`, async () => {
        const db = dbAs(env, uid);
        await assertFails(db.doc(`businesses/${bid}/orders/new`).set({ x: 1 }));
        await assertFails(db.doc(`businesses/${bid}`).update({ "subscription.status": "active" }));
      });
    }
  });
}

describe("owner protection is the isAccountOwner flag, not the 'owner' template", () => {
  const cancelled = STATUS_TENANTS.cancelled.bid;

  it("cancelled: roleTemplate 'owner' without isAccountOwner is locked out", async () => {
    const db = dbAs(env, statusUid("labelOwner", cancelled));
    await assertFails(db.doc(`businesses/${cancelled}`).get());
    await assertFails(db.doc(`businesses/${cancelled}/reports/${DOC}`).get());
    await assertFails(db.doc(`businesses/${cancelled}/metrics/${DOC}`).get());
  });

  it("cancelled: a Staff-template member flagged isAccountOwner gets export-only access to what it holds", async () => {
    const db = dbAs(env, statusUid("staffAccountOwner", cancelled));
    await assertSucceeds(db.doc(`businesses/${cancelled}`).get());
    await assertSucceeds(db.doc(`businesses/${cancelled}/metrics/${DOC}`).get()); // dashboard.view: staff holds it, export-only keeps it
    await assertFails(db.doc(`businesses/${cancelled}/orders/${DOC}`).get()); // staff holds orders.view, export-only drops it
    await assertFails(db.doc(`businesses/${cancelled}/reports/${DOC}`).get()); // staff never held reports.view
  });

  it("cancelled: the real account owner keeps export-only reads", async () => {
    const db = dbAs(env, statusUid("owner", cancelled));
    await assertSucceeds(db.doc(`businesses/${cancelled}/metrics/${DOC}`).get()); // dashboard.view is export-only
    await assertSucceeds(db.doc(`businesses/${cancelled}/reports/${DOC}`).get()); // reports.view is export-only (Reports built in Phase 11)
    await assertSucceeds(db.doc(`businesses/${cancelled}/settings/${DOC}`).get());
    await assertFails(db.doc(`businesses/${cancelled}/customers/${DOC}`).get());
    await assertFails(db.collection(`businesses/${cancelled}/members`).get()); // users.view is not export-only
  });

  it("active: the account-owner flag adds no permissions beyond the stored map", async () => {
    const bid = STATUS_TENANTS.active.bid;
    const db = dbAs(env, statusUid("staffAccountOwner", bid));
    await assertFails(db.doc(`businesses/${bid}/productCosts/${DOC}`).get()); // staff map lacks inventory.costs
    await assertSucceeds(db.doc(`businesses/${bid}/orders/${DOC}`).get());
  });
});
