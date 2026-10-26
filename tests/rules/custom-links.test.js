// Custom workspace links (2026-10-26): the global name registry
// (publicLinks), its count and the Netlify alias lease are server-only, and
// nobody in the browser can give themselves a name or mark the +₱499 add-on
// paid by writing their own business document.
import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { businessDoc, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const B = "cl-rules-a";
const B2 = "cl-rules-b";

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [B, B2]) {
      await db.doc(`businesses/${bid}`).set({ ...businessDoc(`Biz ${bid}`, "active"), customLink: { label: `${bid}`, setup: "active" } });
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
    }
    await db.doc(`publicLinks/${B}`).set({ businessId: B, kind: "current", current: B, setup: "active" });
    await db.doc("publicLinkStats/summary").set({ names: 1 });
    await db.doc("platformLocks/netlify-domains").set({ owner: "x", until: 0 });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("custom link records are server-only", () => {
  it("nobody reads or lists the registry, the count or the lease", async () => {
    for (const who of [dbAs(env, `owner@${B}`), dbAnon(env)]) {
      await assertFails(who.doc(`publicLinks/${B}`).get());
      await assertFails(who.collection("publicLinks").get());
      await assertFails(who.doc("publicLinkStats/summary").get());
      await assertFails(who.doc("platformLocks/netlify-domains").get());
    }
  });
  it("nobody claims a name, takes another's, or resets the count", async () => {
    await assertFails(dbAs(env, `owner@${B2}`).doc("publicLinks/stolen").set({ businessId: B2, kind: "current", setup: "active" }));
    await assertFails(dbAs(env, `owner@${B2}`).doc(`publicLinks/${B}`).set({ businessId: B2 }));
    await assertFails(dbAnon(env).doc("publicLinkStats/summary").set({ names: 0 }));
  });
  it("an Owner can't write their own link or mark the add-on paid on the business document", async () => {
    await assertFails(dbAs(env, `owner@${B}`).doc(`businesses/${B}`).update({ customLink: { label: "free-name", setup: "active" } }));
    await assertFails(dbAs(env, `owner@${B}`).doc(`businesses/${B}`).update({ "subscription.addOnsPaid": ["premium-link"] }));
  });
  it("members read their own business (with its link), never another's", async () => {
    await assertSucceeds(dbAs(env, `owner@${B}`).doc(`businesses/${B}`).get());
    await assertFails(dbAs(env, `owner@${B}`).doc(`businesses/${B2}`).get());
  });
});
