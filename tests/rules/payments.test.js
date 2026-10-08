// Phase 8 rules: payments readable with payments.view (and the Payments
// module); the reference index and every payment write are server-only;
// payment proofs live under tenants/{bid}/payments/ and are never readable
// by another tenant, by anyone signed out, or by public URL.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, B, OUTSIDER, businessDoc, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const OID = "orderAAAAAAAAAAAAAAA";
const PID = "payAAAAAAAAAAAAAAAAA";
const proofPath = (bid) => `tenants/${bid}/payments/proofs/${OID}/${PID}-1a2b3c4d.jpg`;

beforeAll(async () => {
  env = await createEnv({ storage: true });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [A, B]) {
      await db.doc(`businesses/${bid}/orders/${OID}`).set({ orderNumber: "ORD-1", total: 1000000, amountPaid: 400000, balance: 600000, paymentStatus: "partial", createdAt: new Date() });
      await db.doc(`businesses/${bid}/payments/${PID}`).set({ orderId: OID, amount: 400000, method: "gcash", reference: "ABC123", state: "verified", proof: { path: proofPath(bid), contentType: "image/jpeg" }, createdAt: new Date() });
      await db.doc(`businesses/${bid}/paymentRefs/gcash_ABC123`).set({ paymentId: PID, orderId: OID });
      await ctx.storage().ref(proofPath(bid)).putString("\xff\xd8\xff proof of " + bid, "raw", { contentType: "image/jpeg" });
    }
    await seedMember(db, A, "noPayStaffA", { role: "staff", overrides: { revoke: ["payments.view"] } });
    await db.doc("businesses/pay-off").set(businessDoc("Payments off", "active", { planId: "growth", overrides: { modules: { payments: false } } }));
    await seedMember(db, "pay-off", "ownerPayOff", { role: "owner", isAccountOwner: true });
    await db.doc(`businesses/pay-off/payments/${PID}`).set({ amount: 1 });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

const get = (uid, path) => dbAs(env, uid).doc(path).get();

describe("Firestore: payments", () => {
  for (const uid of ["ownerA", "managerA", "staffA"]) {
    it(`${uid} reads A's payments and runs the screen's queries`, async () => {
      const db = dbAs(env, uid);
      await assertSucceeds(get(uid, `businesses/${A}/payments/${PID}`));
      await assertSucceeds(db.collection(`businesses/${A}/payments`).orderBy("createdAt", "desc").limit(25).get());
      await assertSucceeds(db.collection(`businesses/${A}/payments`).where("orderId", "==", OID).orderBy("createdAt", "asc").get());
      await assertSucceeds(db.collection(`businesses/${A}/payments`).where("state", "==", "for_verification").orderBy("createdAt", "desc").limit(25).get());
    });

    it(`${uid} cannot read the reference index, nor anything of B's`, async () => {
      await assertFails(get(uid, `businesses/${A}/paymentRefs/gcash_ABC123`));
      await assertFails(dbAs(env, uid).collection(`businesses/${A}/paymentRefs`).get());
      await assertFails(get(uid, `businesses/${B}/payments/${PID}`));
      await assertFails(get(uid, `businesses/${B}/paymentRefs/gcash_ABC123`));
      await assertFails(dbAs(env, uid).collection(`businesses/${B}/payments`).get());
    });

    it(`${uid} cannot write payments, the index, or an order's payment fields`, async () => {
      const db = dbAs(env, uid);
      await assertFails(db.doc(`businesses/${A}/payments/new-payment-0000001`).set({ orderId: OID, amount: 600000, state: "verified" }));
      await assertFails(db.doc(`businesses/${A}/payments/${PID}`).update({ amount: 1000000 }));
      await assertFails(db.doc(`businesses/${A}/payments/${PID}`).update({ state: "verified" }));
      await assertFails(db.doc(`businesses/${A}/payments/${PID}`).delete());
      await assertFails(db.doc(`businesses/${A}/paymentRefs/gcash_ABC123`).delete());
      await assertFails(db.doc(`businesses/${A}/paymentRefs/gcash_XYZ999`).set({ paymentId: "x" }));
      await assertFails(db.doc(`businesses/${A}/orders/${OID}`).update({ amountPaid: 1000000, balance: 0, paymentStatus: "paid" }));
      await assertFails(db.doc(`businesses/${A}/metrics/current`).set({ unpaidOrders: 0 }, { merge: true }));
      await assertFails(db.doc(`businesses/${A}/financialMetrics/current`).set({ receivablesOutstanding: 0 }, { merge: true }));
    });
  }

  it("without payments.view: no payments", async () => {
    await assertFails(get("noPayStaffA", `businesses/${A}/payments/${PID}`));
  });

  it("Payments module off: nothing, even for the owner", async () => {
    await assertFails(get("ownerPayOff", `businesses/pay-off/payments/${PID}`));
  });

  it("signed out and outsiders: nothing", async () => {
    await assertFails(dbAnon(env).doc(`businesses/${A}/payments/${PID}`).get());
    await assertFails(get(OUTSIDER, `businesses/${A}/payments/${PID}`));
  });
});

describe("Storage: payment proofs", () => {
  const storageAs = (uid) => env.authenticatedContext(uid).storage();

  for (const uid of ["ownerB", "managerB", "staffB"]) {
    it(`B's ${uid} cannot read, download, list or replace A's proof`, async () => {
      const s = storageAs(uid);
      await assertFails(s.ref(proofPath(A)).getMetadata());
      await assertFails(s.ref(proofPath(A)).getDownloadURL());
      await assertFails(s.ref(`tenants/${A}/payments/proofs/${OID}`).listAll());
      await assertFails(s.ref(proofPath(A)).putString("forged"));
      await assertFails(s.ref(proofPath(A)).delete());
    });
  }

  it("signed out (public) access is refused", async () => {
    const s = env.unauthenticatedContext().storage();
    await assertFails(s.ref(proofPath(A)).getMetadata());
    await assertFails(s.ref(proofPath(A)).getDownloadURL());
  });

  it("A's members can't upload proofs from the browser either (server-only writes)", async () => {
    for (const uid of ["ownerA", "managerA", "staffA"]) {
      await assertFails(storageAs(uid).ref(`tenants/${A}/payments/proofs/${OID}/browser.jpg`).putString("x"));
      await assertFails(storageAs(uid).ref(proofPath(A)).delete());
    }
  });

  it("A's own members with payments.view may read it; without it they can't", async () => {
    await assertSucceeds(storageAs("staffA").ref(proofPath(A)).getMetadata());
    await assertFails(storageAs("noPayStaffA").ref(proofPath(A)).getMetadata());
  });
});
