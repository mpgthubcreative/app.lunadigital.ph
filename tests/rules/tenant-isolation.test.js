// Same-tenant reads follow the stored permission map; cross-tenant reads,
// lists, queries and collection-group queries are always refused.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, B, DOC, TENANT_COLLECTIONS, COLLECTION_NAMES, createEnv, dbAs, dbAnon, permissionsOf } from "./fixture.js";

let env;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(async () => {
  await env?.cleanup();
});

const ROLES_A = ["ownerA", "managerA", "staffA"];
const ROLES_B = ["ownerB", "managerB", "staffB"];
// Users who belong to A only. (multiAB, a legitimate member of both, is
// covered in membership.test.js.)
const ATTACKERS = ROLES_A;

const collections = Object.entries(TENANT_COLLECTIONS);

describe("same tenant: reads follow the member's stored permissions", () => {
  for (const uid of [...ROLES_A, ...ROLES_B]) {
    const own = uid.endsWith("A") ? A : B;
    const perms = permissionsOf(uid);

    it(`${uid} can read its own business document`, async () => {
      await assertSucceeds(dbAs(env, uid).doc(`businesses/${own}`).get());
    });

    it(`${uid} can read its own member document`, async () => {
      await assertSucceeds(dbAs(env, uid).doc(`businesses/${own}/members/${uid}`).get());
    });

    for (const [collection, permission] of collections) {
      const allowed = permission !== null && perms[permission] === true;
      it(`${uid} ${allowed ? "CAN" : "cannot"} get + list ${own}/${collection} (${permission ?? "server-only"})`, async () => {
        const db = dbAs(env, uid);
        const get = db.doc(`businesses/${own}/${collection}/${DOC}`).get();
        const list = db.collection(`businesses/${own}/${collection}`).limit(10).get();
        if (allowed) {
          const snap = await assertSucceeds(get);
          expect(snap.data().tenant).toBe(own);
          await assertSucceeds(list);
        } else {
          await assertFails(get);
          await assertFails(list);
        }
      });
    }

    it(`${uid} ${perms["imports.run"] ? "CAN" : "cannot"} read import rows`, async () => {
      const read = dbAs(env, uid).collection(`businesses/${own}/imports/${DOC}/rows`).get();
      if (perms["imports.run"]) await assertSucceeds(read);
      else await assertFails(read);
    });

    it(`${uid} ${perms["users.view"] ? "CAN" : "cannot"} list team members / read a colleague`, async () => {
      const db = dbAs(env, uid);
      const colleague = uid.startsWith("owner") ? `staff${uid.slice(-1)}` : `owner${uid.slice(-1)}`;
      const list = db.collection(`businesses/${own}/members`).get();
      const other = db.doc(`businesses/${own}/members/${colleague}`).get();
      if (perms["users.view"]) {
        await assertSucceeds(list);
        await assertSucceeds(other);
      } else {
        await assertFails(list);
        await assertFails(other);
      }
    });

    it(`${uid} reads only its OWN inbox (Phase 13), never a colleague's`, async () => {
      const colleague = uid.startsWith("owner") ? `staff${uid.slice(-1)}` : `owner${uid.slice(-1)}`;
      await assertSucceeds(dbAs(env, uid).doc(`businesses/${own}/members/${uid}/inbox/${DOC}`).get());
      await assertFails(dbAs(env, uid).doc(`businesses/${own}/members/${colleague}/inbox/${DOC}`).get());
      await assertFails(dbAs(env, uid).collection(`businesses/${own}/members/${colleague}/inbox`).get());
    });
  }
});

describe("cross tenant: Business A members can never read Business B", () => {
  for (const uid of ATTACKERS) {
    describe(uid, () => {
      it("cannot get Business B's business document", async () => {
        await assertFails(dbAs(env, uid).doc(`businesses/${B}`).get());
      });

      it("cannot get or list Business B's members", async () => {
        const db = dbAs(env, uid);
        await assertFails(db.doc(`businesses/${B}/members/ownerB`).get());
        await assertFails(db.collection(`businesses/${B}/members`).get());
        await assertFails(db.collection(`businesses/${B}/members`).where("isAccountOwner", "==", true).get());
      });

      it("cannot read its own uid's (nonexistent) member doc in B", async () => {
        await assertFails(dbAs(env, uid).doc(`businesses/${B}/members/${uid}`).get());
      });

      for (const [collection] of collections) {
        it(`cannot get / list / query / paginate B/${collection}`, async () => {
          const db = dbAs(env, uid);
          const path = `businesses/${B}/${collection}`;
          await assertFails(db.doc(`${path}/${DOC}`).get());
          await assertFails(db.doc(`${path}/does-not-exist`).get());
          await assertFails(db.collection(path).get());
          await assertFails(db.collection(path).limit(1).get());
          await assertFails(db.collection(path).where("tenant", "==", B).get());
          // A query whose filter claims to be A's data is still B's collection.
          await assertFails(db.collection(path).where("businessId", "==", A).get());
          await assertFails(db.collection(path).orderBy("secret").startAfter("").limit(5).get());
        });
      }

      it("cannot read B import rows", async () => {
        await assertFails(dbAs(env, uid).collection(`businesses/${B}/imports/${DOC}/rows`).get());
        await assertFails(dbAs(env, uid).doc(`businesses/${B}/imports/${DOC}/rows/1`).get());
      });

      it("cannot read B inboxes", async () => {
        await assertFails(dbAs(env, uid).doc(`businesses/${B}/members/ownerB/inbox/${DOC}`).get());
        await assertFails(dbAs(env, uid).collection(`businesses/${B}/members/ownerB/inbox`).get());
      });

      it("cannot list or query the businesses collection", async () => {
        const db = dbAs(env, uid);
        await assertFails(db.collection("businesses").get());
        await assertFails(db.collection("businesses").where("name", "==", "Demo Distributor B").get());
        // Not even its own business can be fetched by query.
        await assertFails(db.collection("businesses").where("name", "==", "Demo Distributor A").get());
      });

      for (const name of COLLECTION_NAMES) {
        it(`collection-group query on "${name}" is refused`, async () => {
          const db = dbAs(env, uid);
          await assertFails(db.collectionGroup(name).get());
          await assertFails(db.collectionGroup(name).where("tenant", "==", A).get());
          await assertFails(db.collectionGroup(name).where("uid", "==", uid).get());
        });
      }
    });
  }
});

describe("unauthenticated clients read nothing", () => {
  for (const bid of [A, B]) {
    it(`no access to ${bid}`, async () => {
      const db = dbAnon(env);
      await assertFails(db.doc(`businesses/${bid}`).get());
      await assertFails(db.collection(`businesses/${bid}/members`).get());
      for (const [collection] of collections) {
        await assertFails(db.doc(`businesses/${bid}/${collection}/${DOC}`).get());
        await assertFails(db.collection(`businesses/${bid}/${collection}`).get());
      }
    });
  }
});

describe("root collections are not browser-readable", () => {
  for (const path of ["users/ownerA", "plans/growth", `platformAudit/${DOC}`]) {
    it(`${path} is refused to its owner / any member`, async () => {
      await assertFails(dbAs(env, "ownerA").doc(path).get());
      await assertFails(dbAs(env, "ownerA").collection(path.split("/")[0]).get());
    });
  }
});
