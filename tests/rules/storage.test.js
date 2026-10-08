// Storage tenant isolation: tenants/{bid}/{area}/... is readable only by
// active members of {bid} holding the area's permission (checked through
// cross-service Firestore reads), and nothing is writable from the browser.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, B, MULTI, OUTSIDER, STATUS_TENANTS, STORAGE_AREAS, createEnv, permissionsOf, statusUid } from "./fixture.js";

let env;
beforeAll(async () => {
  env = await createEnv({ storage: true });
});
afterAll(async () => {
  await env?.cleanup();
});

const storageAs = (uid, claims) => env.authenticatedContext(uid, claims).storage();
const file = (bid, area) => `tenants/${bid}/${area}/seed.txt`;

describe("same tenant: reads follow permissions", () => {
  for (const uid of ["ownerA", "managerA", "staffA", "revokedStaffA"]) {
    for (const [area, permission] of Object.entries(STORAGE_AREAS)) {
      const allowed = permissionsOf(uid)[permission] === true;
      it(`${uid} ${allowed ? "CAN" : "cannot"} read A/${area} (${permission})`, async () => {
        const read = storageAs(uid).ref(file(A, area)).getMetadata();
        if (allowed) await assertSucceeds(read);
        else await assertFails(read);
      });
    }
  }

  it("download URLs follow the same rule", async () => {
    await assertSucceeds(storageAs("ownerA").ref(file(A, "products")).getDownloadURL());
    await assertFails(storageAs("staffA").ref(file(A, "exports")).getDownloadURL());
  });

  it("areas outside the approved list are refused even to the owner", async () => {
    await assertFails(storageAs("ownerA").ref(`tenants/${A}/private/seed.txt`).getMetadata());
  });
});

describe("cross tenant: A can never read, list or write B's files", () => {
  for (const uid of ["ownerA", "managerA", "staffA"]) {
    for (const area of Object.keys(STORAGE_AREAS)) {
      it(`${uid} vs B/${area}: read, list, upload, overwrite, delete all refused`, async () => {
        const storage = storageAs(uid);
        await assertFails(storage.ref(file(B, area)).getMetadata());
        await assertFails(storage.ref(file(B, area)).getDownloadURL());
        await assertFails(storage.ref(`tenants/${B}/${area}`).listAll());
        await assertFails(storage.ref(`tenants/${B}/${area}/new.txt`).putString("x"));
        await assertFails(storage.ref(file(B, area)).putString("overwrite"));
        await assertFails(storage.ref(file(B, area)).delete());
        await assertFails(storage.ref(file(B, area)).updateMetadata({ customMetadata: { x: "1" } }));
      });
    }

    it(`${uid} cannot list tenants/ or tenants/B`, async () => {
      await assertFails(storageAs(uid).ref("tenants").listAll());
      await assertFails(storageAs(uid).ref(`tenants/${B}`).listAll());
    });
  }

  it("forged claims and the tampered businessIds index grant nothing", async () => {
    await assertFails(storageAs("ownerA", { businessId: B, platformAdmin: true }).ref(file(B, "products")).getMetadata());
    await assertFails(storageAs(OUTSIDER).ref(file(B, "products")).getMetadata());
    await assertFails(storageAs(OUTSIDER).ref(file(A, "products")).getMetadata());
  });

  it("a member of both reads B under B's membership only", async () => {
    // manager in B: exports needs reports.export, which managers hold
    await assertSucceeds(storageAs(MULTI.uid).ref(file(B, "exports")).getMetadata());
    // staff in A: no reports.export there
    await assertFails(storageAs(MULTI.uid).ref(file(A, "exports")).getMetadata());
  });
});

describe("no browser writes anywhere", () => {
  for (const uid of ["ownerA", "managerA", "staffA"]) {
    it(`${uid} cannot upload, overwrite or delete in its own tenant`, async () => {
      const storage = storageAs(uid);
      for (const area of Object.keys(STORAGE_AREAS)) {
        await assertFails(storage.ref(`tenants/${A}/${area}/new.txt`).putString("x"));
        await assertFails(storage.ref(file(A, area)).putString("overwrite"));
        await assertFails(storage.ref(file(A, area)).delete());
      }
    });
  }

  it("nothing outside tenants/ is reachable", async () => {
    await assertFails(storageAs("ownerA").ref("public/seed.txt").getMetadata());
    await assertFails(storageAs("ownerA").ref("public/new.txt").putString("x"));
    await assertFails(env.unauthenticatedContext().storage().ref("public/seed.txt").getMetadata());
  });

  it("unauthenticated users read nothing", async () => {
    await assertFails(env.unauthenticatedContext().storage().ref(file(A, "products")).getMetadata());
  });
});

describe("disabled members and subscription states", () => {
  it("a disabled member reads nothing", async () => {
    await assertFails(storageAs("disabledA").ref(file(A, "products")).getMetadata());
  });

  it("suspended: reads continue", async () => {
    const bid = STATUS_TENANTS.suspended.bid;
    await assertSucceeds(storageAs(statusUid("staff", bid)).ref(file(bid, "products")).getMetadata());
  });

  it("cancelled: account owner may read exports only; staff nothing", async () => {
    const bid = STATUS_TENANTS.cancelled.bid;
    await assertSucceeds(storageAs(statusUid("owner", bid)).ref(file(bid, "exports")).getMetadata());
    await assertFails(storageAs(statusUid("owner", bid)).ref(file(bid, "products")).getMetadata());
    await assertFails(storageAs(statusUid("staff", bid)).ref(file(bid, "exports")).getMetadata());
    await assertFails(storageAs(statusUid("labelOwner", bid)).ref(file(bid, "exports")).getMetadata());
  });

  it("unknown / missing status: nothing", async () => {
    for (const key of ["unknown", "missing", "wrongCase"]) {
      const bid = STATUS_TENANTS[key].bid;
      await assertFails(storageAs(statusUid("owner", bid)).ref(file(bid, "exports")).getMetadata());
    }
  });
});
