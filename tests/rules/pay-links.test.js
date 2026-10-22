// Order payment links (2026-10-22): the public lookup (top-level
// orderPayLinks/{hash}), the stored link (businesses/{bid}/orderPayLinks)
// and the submit counters (payThrottle) are server-only: no browser, not
// even the business's Owner or an anonymous customer, reads or writes
// them. Customers pay only through /api/pay; a payment it records is an
// ordinary payment (payments.view to read, as before).

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { businessDoc, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const B = "pay-link-a";
const B2 = "pay-link-b";

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [B, B2]) {
      await db.doc(`businesses/${bid}`).set(businessDoc(`Biz ${bid}`, "active"));
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
      await db.doc(`businesses/${bid}/orderPayLinks/o1`).set({ token: "T".repeat(32), hash: `h-${bid}` });
      await db.doc(`businesses/${bid}/payments/p1`).set({ orderId: "o1", amount: 1000, method: "gcash", state: "for_verification", via: "payment_link" });
    }
    await db.doc(`orderPayLinks/h-${B}`).set({ businessId: B, orderId: "o1" });
    await db.doc("payThrottle/c1").set({ count: 1 });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("payment link secrets are server-only", () => {
  it("nobody reads or lists the lookups, the stored links or the counters", async () => {
    for (const who of [dbAs(env, `owner@${B}`), dbAnon(env)]) {
      await assertFails(who.doc(`orderPayLinks/h-${B}`).get());
      await assertFails(who.collection("orderPayLinks").get());
      await assertFails(who.doc(`businesses/${B}/orderPayLinks/o1`).get());
      await assertFails(who.collection(`businesses/${B}/orderPayLinks`).get());
      await assertFails(who.doc("payThrottle/c1").get());
    }
  });
  it("nobody writes them (no forged lookup pointing at another business's order)", async () => {
    await assertFails(dbAnon(env).doc("orderPayLinks/forged").set({ businessId: B2, orderId: "o1" }));
    await assertFails(dbAs(env, `owner@${B}`).doc("orderPayLinks/forged").set({ businessId: B2, orderId: "o1" }));
    await assertFails(dbAs(env, `owner@${B}`).doc(`businesses/${B}/orderPayLinks/o1`).set({ token: "x" }));
    await assertFails(dbAnon(env).doc(`businesses/${B}/payments/p2`).set({ orderId: "o1", amount: 1, state: "verified" }));
  });
  it("a payment sent from a link is read like any payment: its own business only", async () => {
    await assertSucceeds(dbAs(env, `owner@${B}`).doc(`businesses/${B}/payments/p1`).get());
    await assertFails(dbAs(env, `owner@${B}`).doc(`businesses/${B2}/payments/p1`).get());
    await assertFails(dbAnon(env).doc(`businesses/${B}/payments/p1`).get());
  });
});
