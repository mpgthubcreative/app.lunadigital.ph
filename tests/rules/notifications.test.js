// Phase 13 rules: a member reads ONLY their own inbox and unread counter
// (notifications.view + the core Dashboard module + the plan's in-app
// notifications), runs the bell's and the page's queries, and can't write
// any of it. Other members, other businesses, disabled members, cancelled
// accounts and packages without in-app notifications read nothing.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, B, businessDoc, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const NID = "payment_awaiting_verification__abc123";

const notification = (uid, bid, extra = {}) => ({ businessId: bid, recipientUid: uid, type: "payment.awaiting_verification", category: "payments", title: "Payment awaiting verification", message: "x", read: false, resolved: false, createdAt: new Date("2026-10-08T01:00:00Z"), ...extra });

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const seed = async (bid, uid) => {
      await db.doc(`businesses/${bid}/members/${uid}/inbox/${NID}`).set(notification(uid, bid));
      await db.doc(`businesses/${bid}/members/${uid}/inbox/n2`).set(notification(uid, bid, { read: true, category: "inventory", createdAt: new Date("2026-10-07T01:00:00Z") }));
      await db.doc(`businesses/${bid}/members/${uid}/inboxState/summary`).set({ unread: 1 });
    };
    for (const uid of ["ownerA", "managerA", "staffA", "disabledA"]) await seed(A, uid);
    for (const uid of ["ownerB", "managerB"]) await seed(B, uid);
    await seed(A, "multiAB");
    await seed(B, "multiAB");
    await seedMember(db, A, "noNotesA", { role: "manager", overrides: { revoke: ["notifications.view"] } });
    await seed(A, "noNotesA");
    // A package without in-app notifications.
    await db.doc("businesses/no-inapp").set(businessDoc("No in-app", "active", { planId: "growth", overrides: { features: { inAppNotifications: false } } }));
    await seedMember(db, "no-inapp", "ownerNoInApp", { role: "owner", isAccountOwner: true });
    await seed("no-inapp", "ownerNoInApp");
    // Notifications are core: a Bridal workspace member reads their own inbox.
    await db.doc("businesses/notes-bridal").set(businessDoc("Bridal", "active", { planId: "pro", workspaceTemplateId: "bridal-expense" }));
    await seedMember(db, "notes-bridal", "ownerBridal", { role: "owner", isAccountOwner: true });
    await seed("notes-bridal", "ownerBridal");
    // Cancelled: export-only permissions don't include notifications.
    await seed("sub-cancelled", "owner@sub-cancelled");
  });
});
afterAll(async () => {
  await env?.cleanup();
});

const inbox = (bid, uid) => `businesses/${bid}/members/${uid}/inbox`;
const state = (bid, uid) => `businesses/${bid}/members/${uid}/inboxState/summary`;

describe("own inbox", () => {
  for (const uid of ["ownerA", "managerA", "staffA"]) {
    it(`${uid} reads its notification, counter, the bell's latest-8 and the page's filtered queries`, async () => {
      const db = dbAs(env, uid);
      await assertSucceeds(db.doc(`${inbox(A, uid)}/${NID}`).get());
      await assertSucceeds(db.doc(state(A, uid)).get());
      const ref = db.collection(inbox(A, uid));
      await assertSucceeds(ref.orderBy("createdAt", "desc").limit(9).get());
      await assertSucceeds(ref.where("read", "==", false).orderBy("createdAt", "desc").limit(21).get());
      await assertSucceeds(ref.where("category", "==", "inventory").orderBy("createdAt", "desc").limit(21).get());
      await assertSucceeds(ref.where("read", "==", false).where("category", "==", "payments").orderBy("createdAt", "desc").limit(21).get());
    });
  }

  it("a member of two businesses reads each inbox through that business's membership", async () => {
    await assertSucceeds(dbAs(env, "multiAB").doc(`${inbox(A, "multiAB")}/${NID}`).get());
    await assertSucceeds(dbAs(env, "multiAB").doc(`${inbox(B, "multiAB")}/${NID}`).get());
  });

  it("a Bridal workspace member reads their own inbox (core capability)", async () => {
    await assertSucceeds(dbAs(env, "ownerBridal").doc(`${inbox("notes-bridal", "ownerBridal")}/${NID}`).get());
  });
});

describe("refused", () => {
  it("a colleague's inbox or counter, even for the owner", async () => {
    const db = dbAs(env, "ownerA");
    await assertFails(db.doc(`${inbox(A, "managerA")}/${NID}`).get());
    await assertFails(db.collection(inbox(A, "managerA")).get());
    await assertFails(db.doc(state(A, "managerA")).get());
    await assertFails(dbAs(env, "staffA").doc(state(A, "ownerA")).get());
  });

  it("Business B's inboxes and counters, from every A role; and A's from B", async () => {
    for (const uid of ["ownerA", "managerA", "staffA"]) {
      await assertFails(dbAs(env, uid).doc(`${inbox(B, "ownerB")}/${NID}`).get());
      await assertFails(dbAs(env, uid).collection(inbox(B, "ownerB")).get());
      await assertFails(dbAs(env, uid).doc(state(B, "ownerB")).get());
      // its own uid's path under B (it isn't a B member)
      await assertFails(dbAs(env, uid).doc(state(B, uid)).get());
    }
    await assertFails(dbAs(env, "ownerB").doc(`${inbox(A, "ownerA")}/${NID}`).get());
  });

  it("collection-group queries over every inbox", async () => {
    await assertFails(dbAs(env, "ownerA").collectionGroup("inbox").get());
    await assertFails(dbAs(env, "ownerA").collectionGroup("inbox").where("recipientUid", "==", "ownerA").get());
  });

  it("a disabled member, a member without notifications.view, signed-out users", async () => {
    await assertFails(dbAs(env, "disabledA").doc(`${inbox(A, "disabledA")}/${NID}`).get());
    await assertFails(dbAs(env, "disabledA").doc(state(A, "disabledA")).get());
    await assertFails(dbAs(env, "noNotesA").doc(`${inbox(A, "noNotesA")}/${NID}`).get());
    await assertFails(dbAnon(env).doc(`${inbox(A, "ownerA")}/${NID}`).get());
  });

  it("a package without in-app notifications; a cancelled account", async () => {
    await assertFails(dbAs(env, "ownerNoInApp").doc(`${inbox("no-inapp", "ownerNoInApp")}/${NID}`).get());
    await assertFails(dbAs(env, "ownerNoInApp").doc(state("no-inapp", "ownerNoInApp")).get());
    await assertFails(dbAs(env, "owner@sub-cancelled").doc(`${inbox("sub-cancelled", "owner@sub-cancelled")}/${NID}`).get());
  });

  it("no writes at all: not read state, not the counter, not a forged notification", async () => {
    const db = dbAs(env, "ownerA");
    await assertFails(db.doc(`${inbox(A, "ownerA")}/${NID}`).update({ read: true }));
    await assertFails(db.doc(`${inbox(A, "ownerA")}/${NID}`).delete());
    await assertFails(db.doc(`${inbox(A, "ownerA")}/forged`).set(notification("ownerA", A)));
    await assertFails(db.doc(`${inbox(A, "managerA")}/forged`).set(notification("managerA", A)));
    await assertFails(db.doc(state(A, "ownerA")).set({ unread: 0 }));
    await assertFails(db.doc(`businesses/${A}/members/ownerA`).update({ notificationPreferences: { inventory: { inApp: false } } }));
  });
});
