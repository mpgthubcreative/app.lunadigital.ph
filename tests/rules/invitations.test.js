// Owner-pilot Bridal rules: the invitation link lookups (top-level
// invitations/{hash}), the stored links (businesses/{bid}/guestInvites) and
// the Wedding Setup (businesses/{bid}/weddingSetup) are server-only: no
// browser, not even the wedding's Owner or an anonymous guest, can read or
// write them. Guests answer only through /api/invite. The seating document
// (guestTotals/seating) follows guests.view like the other guest totals.
// The friendly wedding links (top-level weddingSlugs/{slug}) are server-only too.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { businessDoc, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const W = "wed-inv-a";
const W2 = "wed-inv-b";

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [W, W2]) {
      await db.doc(`businesses/${bid}`).set(businessDoc(`Wedding ${bid}`, "active", { planId: "bridal-plus", workspaceTemplateId: "bridal-expense" }));
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
      await db.doc(`businesses/${bid}/guests/g1`).set({ name: "Maria Santos", partySize: 2, rsvp: "awaiting", confirmed: 0, nameLower: "maria santos" });
      await db.doc(`businesses/${bid}/guestInvites/g1`).set({ token: "T".repeat(32), hash: "h1" });
      await db.doc(`businesses/${bid}/weddingSetup/current`).set({ coupleNames: "Camille & Carlo", rsvpEnabled: true });
      await db.doc(`businesses/${bid}/weddingSetup/hero`).set({ dataUrl: "data:image/jpeg;base64,AAAA" });
      await db.doc(`businesses/${bid}/guestTotals/seating`).set({ tables: { tA1b2c3d4: { name: "Table 1", capacity: 8, order: 1 } } });
    }
    await seedMember(db, W, "staff@wed-inv-a", { role: "staff" });
    await db.doc(`invitations/h1`).set({ businessId: W, guestId: "g1" });
    await db.doc("weddingSlugs/carloyanieforever").set({ businessId: W });
    await db.doc(`businesses/${W}/invitationDesign/current`).set({ live: "custom", published: { config: { templateId: "garden" } } });
    await db.doc(`businesses/${W}/invitationAssets/asset0001`).set({ name: "bg.png", dataUrl: "data:image/png;base64,AAAA" });
    await db.doc(`businesses/${W}/weddingGallery/photo0001`).set({ dataUrl: "data:image/jpeg;base64,AAAA", order: 10 });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("invitation secrets are server-only", () => {
  it("nobody reads or lists the link lookups (owner, anonymous guest)", async () => {
    await assertFails(dbAs(env, `owner@${W}`).doc("invitations/h1").get());
    await assertFails(dbAnon(env).doc("invitations/h1").get());
    await assertFails(dbAs(env, `owner@${W}`).collection("invitations").get());
    await assertFails(dbAnon(env).collection("invitations").get());
  });
  it("nobody reads the stored links or the setup, even the wedding's Owner", async () => {
    for (const p of [`businesses/${W}/guestInvites/g1`, `businesses/${W}/weddingSetup/current`, `businesses/${W}/weddingSetup/hero`]) {
      await assertFails(dbAs(env, `owner@${W}`).doc(p).get());
      await assertFails(dbAnon(env).doc(p).get());
    }
    await assertFails(dbAs(env, `owner@${W}`).collection(`businesses/${W}/guestInvites`).get());
  });
  it("nobody writes them (no forged lookup, no RSVP written from a browser)", async () => {
    await assertFails(dbAnon(env).doc("invitations/forged").set({ businessId: W, guestId: "g1" }));
    await assertFails(dbAs(env, `owner@${W}`).doc("invitations/forged").set({ businessId: W, guestId: "g1" }));
    await assertFails(dbAs(env, `owner@${W}`).doc(`businesses/${W}/guestInvites/g1`).set({ token: "x" }));
    await assertFails(dbAs(env, `owner@${W}`).doc(`businesses/${W}/weddingSetup/current`).set({ rsvpEnabled: false }));
    await assertFails(dbAnon(env).doc(`businesses/${W}/guests/g1`).update({ rsvp: "attending", confirmed: 2 }));
    await assertFails(dbAs(env, `owner@${W}`).doc(`businesses/${W}/guests/g1`).update({ rsvp: "attending", confirmed: 2 }));
  });
  it("the wedding link registry (weddingSlugs) is server-only: no read, list, claim or takeover from a browser", async () => {
    for (const db of [dbAs(env, `owner@${W}`), dbAs(env, `owner@${W2}`), dbAnon(env)]) {
      await assertFails(db.doc("weddingSlugs/carloyanieforever").get());
      await assertFails(db.collection("weddingSlugs").get());
      await assertFails(db.doc("weddingSlugs/carloyanieforever").set({ businessId: W2 }));
      await assertFails(db.doc("weddingSlugs/new-slug").set({ businessId: W2 }));
      await assertFails(db.doc("weddingSlugs/carloyanieforever").delete());
    }
  });
  it("invitation designs, design images and gallery photos are server-only (Super Admin / API), even for the wedding's Owner", async () => {
    for (const db of [dbAs(env, `owner@${W}`), dbAs(env, `staff@${W}`), dbAnon(env)]) {
      for (const p of [`businesses/${W}/invitationDesign/current`, `businesses/${W}/invitationAssets/asset0001`, `businesses/${W}/weddingGallery/photo0001`]) {
        await assertFails(db.doc(p).get());
        await assertFails(db.doc(p).set({ hacked: true }));
      }
      await assertFails(db.collection(`businesses/${W}/invitationAssets`).get());
    }
    await assertFails(dbAs(env, `owner@${W}`).doc(`businesses/${W}/invitationDesign/current`).update({ live: "standard" }));
  });
  it("seating: guests.view of THIS wedding only; anonymous / other wedding / staff denied", async () => {
    await assertSucceeds(dbAs(env, `owner@${W}`).doc(`businesses/${W}/guestTotals/seating`).get());
    await assertFails(dbAs(env, `owner@${W2}`).doc(`businesses/${W}/guestTotals/seating`).get());
    await assertFails(dbAs(env, `staff@${W}`).doc(`businesses/${W}/guestTotals/seating`).get());
    await assertFails(dbAnon(env).doc(`businesses/${W}/guestTotals/seating`).get());
    await assertFails(dbAnon(env).doc(`businesses/${W}/guests/g1`).get());
  });
});
