// Things that must NOT grant access (index entries, claims, role labels,
// disabled / missing memberships, truthy values) and permission behaviour
// (specific keys, revocation taking effect immediately).
//
// Browser-only state (localStorage, the X-Luna-Business-Id header, URL
// params) never reaches Firestore rules: the only "business id" a rule
// sees is the document path, so "changing the requested businessId" is the
// cross-tenant path attack covered here and in tenant-isolation.test.js.
// The header itself is covered by tests/functions/session.test.js.

import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, B, DOC, MULTI, OUTSIDER, createEnv, dbAs, seedWorld } from "./fixture.js";

let env;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(async () => {
  await env?.cleanup();
});

const order = (bid) => `businesses/${bid}/orders/${DOC}`;
const report = (bid) => `businesses/${bid}/reports/${DOC}`;
const asAdmin = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()));

describe("these do not grant access", () => {
  it("users/{uid}.businessIds listing Business B (outsider, no membership)", async () => {
    const db = dbAs(env, OUTSIDER);
    await assertFails(db.doc(`businesses/${B}`).get());
    await assertFails(db.doc(order(B)).get());
    await assertFails(db.doc(order(A)).get());
    await assertFails(db.collection(`businesses/${B}/orders`).get());
  });

  it("users/{uid}.businessIds tampered server-side to add B for an A owner", async () => {
    await asAdmin((db) => db.doc("users/ownerA").update({ businessIds: [A, B], defaultBusinessId: B }));
    try {
      await assertFails(dbAs(env, "ownerA").doc(`businesses/${B}`).get());
      await assertFails(dbAs(env, "ownerA").doc(order(B)).get());
    } finally {
      await asAdmin((db) => db.doc("users/ownerA").update({ businessIds: [A], defaultBusinessId: A }));
    }
  });

  it.each([
    ["businessId claim", { businessId: B }],
    ["businessIds claim", { businessIds: [A, B] }],
    ["role claim", { role: "owner", roleTemplate: "owner" }],
    ["permissions claim", { permissions: { "orders.view": true } }],
    ["platformAdmin claim", { platformAdmin: true }],
    ["admin claim", { admin: true }],
  ])("a forged %s on the ID token", async (_label, claims) => {
    const db = dbAs(env, "ownerA", claims);
    await assertFails(db.doc(`businesses/${B}`).get());
    await assertFails(db.doc(order(B)).get());
    await assertFails(db.collection(`businesses/${B}/orders`).get());
  });

  it("platformAdmin with no membership reads no tenant data", async () => {
    const db = dbAs(env, "luna-super-admin", { platformAdmin: true });
    for (const bid of [A, B]) {
      await assertFails(db.doc(`businesses/${bid}`).get());
      await assertFails(db.doc(order(bid)).get());
    }
  });

  it("a disabled membership (role template Manager)", async () => {
    const db = dbAs(env, "disabledA");
    await assertFails(db.doc(`businesses/${A}`).get());
    await assertFails(db.doc(`businesses/${A}/members/disabledA`).get());
    await assertFails(db.doc(order(A)).get());
    await assertFails(db.doc(report(A)).get());
  });

  it("a nonexistent membership (a uid that only exists in Auth)", async () => {
    const db = dbAs(env, "never-added");
    await assertFails(db.doc(`businesses/${A}`).get());
    await assertFails(db.doc(order(A)).get());
  });

  it("a roleTemplate of 'owner' whose stored permissions are Staff's", async () => {
    const db = dbAs(env, "labelOwnerA");
    await assertSucceeds(db.doc(order(A)).get()); // staff has orders.view
    await assertFails(db.doc(report(A)).get()); // staff lacks reports.view
    await assertFails(db.collection(`businesses/${A}/members`).get()); // lacks users.view
    await assertFails(db.doc(`businesses/${A}/imports/${DOC}`).get());
  });

  it("truthy non-boolean permission values ('true', 1, {}, [true])", async () => {
    const db = dbAs(env, "truthyA");
    await assertSucceeds(db.doc(`businesses/${A}`).get()); // still an active member
    await assertFails(db.doc(report(A)).get());
    await assertFails(db.doc(order(A)).get());
    await assertFails(db.doc(`businesses/${A}/customers/${DOC}`).get());
    await assertFails(db.collection(`businesses/${A}/members`).get());
  });

  it("membership in A does not leak into B, and B access follows B's membership", async () => {
    const db = dbAs(env, MULTI.uid);
    // staff in A: orders yes, reports no
    await assertSucceeds(db.doc(order(A)).get());
    await assertFails(db.doc(report(A)).get());
    // manager in B: reports yes (from B's own membership)
    await assertSucceeds(db.doc(report(B)).get());
    await assertFails(db.doc(`businesses/${B}/integrations/${DOC}`).get());
  });
});

describe("granular permissions", () => {
  it("staff with orders.view can read and query orders", async () => {
    const db = dbAs(env, "staffA");
    await assertSucceeds(db.doc(order(A)).get());
    await assertSucceeds(db.collection(`businesses/${A}/orders`).where("tenant", "==", A).limit(25).get());
  });

  it("staff without reports.view cannot read reports", async () => {
    const db = dbAs(env, "staffA");
    await assertFails(db.doc(report(A)).get());
    await assertFails(db.collection(`businesses/${A}/reports`).get());
  });

  it("a per-member grant (staff + reports.view) works", async () => {
    await assertSucceeds(dbAs(env, "grantedStaffA").doc(report(A)).get());
  });

  it("a per-member revoke (staff - orders.view) works", async () => {
    const db = dbAs(env, "revokedStaffA");
    await assertFails(db.doc(order(A)).get());
    await assertSucceeds(db.doc(`businesses/${A}/customers/${DOC}`).get());
  });

  it("manager reads reports but not integrations (server-only)", async () => {
    const db = dbAs(env, "managerA");
    await assertSucceeds(db.doc(report(A)).get());
    await assertFails(db.doc(`businesses/${A}/integrations/${DOC}`).get());
  });
});

describe("changes take effect immediately", () => {
  beforeEach(async () => {
    await seedWorld(env);
  });

  it("revoking a permission on the member document", async () => {
    const db = dbAs(env, "managerA");
    await assertSucceeds(db.doc(report(A)).get());
    // Read-modify-write: a dotted update path would mean permissions.reports.view
    // (nested), not the "reports.view" key.
    await asAdmin(async (admin) => {
      const ref = admin.doc(`businesses/${A}/members/managerA`);
      const { permissions } = (await ref.get()).data();
      await ref.update({ permissions: { ...permissions, "reports.view": false } });
    });
    await assertFails(db.doc(report(A)).get());
  });

  it("deleting the permission key", async () => {
    const db = dbAs(env, "staffA");
    await assertSucceeds(db.doc(order(A)).get());
    await asAdmin(async (admin) => {
      const ref = admin.doc(`businesses/${A}/members/staffA`);
      const { permissions } = (await ref.get()).data();
      delete permissions["orders.view"];
      await ref.update({ permissions });
    });
    await assertFails(db.doc(order(A)).get());
  });

  it("disabling the membership", async () => {
    const db = dbAs(env, "ownerA");
    await assertSucceeds(db.doc(order(A)).get());
    await asAdmin((admin) => admin.doc(`businesses/${A}/members/ownerA`).update({ status: "disabled" }));
    await assertFails(db.doc(order(A)).get());
    await assertFails(db.doc(`businesses/${A}`).get());
  });

  it("deleting the membership", async () => {
    const db = dbAs(env, "staffA");
    await asAdmin((admin) => admin.doc(`businesses/${A}/members/staffA`).delete());
    await assertFails(db.doc(order(A)).get());
  });

  it("changing only the roleTemplate string grants nothing", async () => {
    const db = dbAs(env, "staffA");
    await asAdmin((admin) => admin.doc(`businesses/${A}/members/staffA`).update({ roleTemplate: "owner" }));
    await assertFails(db.doc(report(A)).get());
    await assertFails(db.collection(`businesses/${A}/members`).get());
  });

  it("an unknown member status is treated as inactive", async () => {
    const db = dbAs(env, "staffA");
    for (const status of ["ACTIVE", "enabled", true, null]) {
      await asAdmin((admin) => admin.doc(`businesses/${A}/members/staffA`).update({ status }));
      await assertFails(db.doc(order(A)).get());
    }
  });

  it("a member document with permissions that are not a map grants nothing", async () => {
    const db = dbAs(env, "managerA");
    for (const permissions of ["all", true, ["reports.view"], null]) {
      await asAdmin((admin) => admin.doc(`businesses/${A}/members/managerA`).update({ permissions }));
      await assertFails(db.doc(report(A)).get());
    }
  });

  it("a business document that disappears denies everything", async () => {
    const db = dbAs(env, "ownerA");
    await asAdmin((admin) => admin.doc(`businesses/${A}`).delete());
    await assertFails(db.doc(order(A)).get());
  });
});
