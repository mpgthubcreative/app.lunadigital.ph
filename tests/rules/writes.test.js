// Every browser write is refused: same tenant, cross tenant, membership
// self-escalation, index tampering and new-tenant creation. Writes go
// through server functions only.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFails } from "@firebase/rules-unit-testing";
import { A, B, DOC, TENANT_COLLECTIONS, createEnv, dbAs, dbAnon } from "./fixture.js";

let env;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(async () => {
  await env?.cleanup();
});

const WRITERS = ["ownerA", "managerA", "staffA"];
const targets = [...Object.keys(TENANT_COLLECTIONS), "members"];

const WRITE_KINDS = ["create", "add", "overwrite", "merge", "update", "delete", "batch", "transaction"];

function writeAttempts(db, path, collectionPath) {
  return {
    create: () => db.doc(`${collectionPath}/new-doc`).set({ tenant: "x" }),
    add: () => db.collection(collectionPath).add({ tenant: "x" }),
    overwrite: () => db.doc(path).set({ tenant: "x" }),
    merge: () => db.doc(path).set({ tampered: true }, { merge: true }),
    update: () => db.doc(path).update({ tampered: true }),
    delete: () => db.doc(path).delete(),
    batch: () => {
      const batch = db.batch();
      batch.set(db.doc(`${collectionPath}/batch-doc`), { tenant: "x" });
      return batch.commit();
    },
    transaction: () => db.runTransaction(async (tx) => tx.set(db.doc(`${collectionPath}/tx-doc`), { tenant: "x" })),
  };
}

for (const uid of WRITERS) {
  for (const bid of [A, B]) {
    describe(`${uid} writing to ${bid === A ? "its own business (A)" : "Business B"}`, () => {
      it("cannot create/update/delete the business document", async () => {
        const db = dbAs(env, uid);
        await assertFails(db.doc(`businesses/${bid}`).set({ name: "x" }));
        await assertFails(db.doc(`businesses/${bid}`).update({ "subscription.status": "active" }));
        await assertFails(db.doc(`businesses/${bid}`).delete());
      });

      for (const collection of targets) {
        const docId = collection === "members" ? (bid === A ? "staffA" : "ownerB") : DOC;
        for (const kind of WRITE_KINDS) {
          it(`${kind} on ${collection} is refused`, async () => {
            const attempts = writeAttempts(dbAs(env, uid), `businesses/${bid}/${collection}/${docId}`, `businesses/${bid}/${collection}`);
            await assertFails(attempts[kind]());
          });
        }
      }

      it("cannot write import rows or inbox items", async () => {
        const db = dbAs(env, uid);
        await assertFails(db.doc(`businesses/${bid}/imports/${DOC}/rows/2`).set({ row: 2 }));
        await assertFails(db.doc(`businesses/${bid}/members/${uid}/inbox/${DOC}`).update({ readAt: new Date() }));
      });
    });
  }
}

describe("membership self-escalation is refused", () => {
  const ownMember = (uid) => `businesses/${A}/members/${uid}`;

  it("staff cannot grant itself permissions", async () => {
    await assertFails(dbAs(env, "staffA").doc(ownMember("staffA")).update({ "permissions.reports.view": true }));
    await assertFails(dbAs(env, "staffA").doc(ownMember("staffA")).update({ permissions: { "reports.view": true } }));
    await assertFails(dbAs(env, "staffA").doc(ownMember("staffA")).set({ permissions: { "reports.view": true } }, { merge: true }));
  });

  it("staff cannot change its roleTemplate or become account owner", async () => {
    await assertFails(dbAs(env, "staffA").doc(ownMember("staffA")).update({ roleTemplate: "owner" }));
    await assertFails(dbAs(env, "staffA").doc(ownMember("staffA")).update({ isAccountOwner: true }));
  });

  it("a disabled member cannot re-enable itself", async () => {
    await assertFails(dbAs(env, "disabledA").doc(ownMember("disabledA")).update({ status: "active" }));
  });

  it("an owner cannot strip another account owner's flag or delete them", async () => {
    await assertFails(dbAs(env, "managerA").doc(ownMember("ownerA")).update({ isAccountOwner: false }));
    await assertFails(dbAs(env, "managerA").doc(ownMember("ownerA")).delete());
  });

  it("A owner cannot add itself as a member of B", async () => {
    await assertFails(
      dbAs(env, "ownerA").doc(`businesses/${B}/members/ownerA`).set({ uid: "ownerA", status: "active", roleTemplate: "owner", permissions: { "orders.view": true }, isAccountOwner: true })
    );
  });

  it("a signed-in stranger cannot create a business or a membership", async () => {
    const db = dbAs(env, "outsider");
    await assertFails(db.doc("businesses/brand-new-biz").set({ name: "Mine", subscription: { status: "active" } }));
    await assertFails(db.doc("businesses/brand-new-biz/members/outsider").set({ status: "active", permissions: { "orders.view": true } }));
  });
});

describe("index tampering is refused", () => {
  it("a user cannot add Business B to users/{uid}.businessIds", async () => {
    const db = dbAs(env, "ownerA");
    await assertFails(db.doc("users/ownerA").update({ businessIds: [A, B] }));
    await assertFails(db.doc("users/ownerA").set({ businessIds: [A, B], defaultBusinessId: B }, { merge: true }));
    await assertFails(db.doc("users/ownerA").set({ businessIds: [A, B] }));
  });

  it("nobody can write plans or platform audit", async () => {
    const db = dbAs(env, "ownerA", { platformAdmin: true });
    await assertFails(db.doc("plans/growth").update({ "limits.users": 9999 }));
    await assertFails(db.doc(`platformAudit/${DOC}`).delete());
  });
});

describe("unauthenticated writes are refused", () => {
  for (const bid of [A, B]) {
    it(`anonymous cannot write anything in ${bid}`, async () => {
      const db = dbAnon(env);
      await assertFails(db.doc(`businesses/${bid}`).set({ name: "x" }));
      for (const collection of targets) {
        await assertFails(db.doc(`businesses/${bid}/${collection}/anon`).set({ x: 1 }));
      }
    });
  }
});

it("seed data is untouched after every attack", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const staff = (await db.doc(`businesses/${A}/members/staffA`).get()).data();
    expect(staff.roleTemplate).toBe("staff");
    expect(staff.isAccountOwner).toBe(false);
    expect(staff.permissions["reports.view"]).toBeUndefined();
    expect((await db.doc(`businesses/${B}/members/ownerA`).get()).exists).toBe(false);
    expect((await db.doc("users/ownerA").get()).data().businessIds).toEqual([A]);
    expect((await db.doc("businesses/brand-new-biz").get()).exists).toBe(false);
    expect((await db.doc(`businesses/${B}/orders/${DOC}`).get()).data().tampered).toBeUndefined();
  });
});
