// Bridal free-trial requests (2026-10-28): trialRequests and their daily
// limits are server-only. Visitors send through /api/trial-request; nobody
// in the browser reads others' requests or writes their own.
import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails } from "@firebase/rules-unit-testing";
import { businessDoc, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const B = "tr-rules-a";

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc(`businesses/${B}`).set(businessDoc("Biz", "active"));
    await seedMember(db, B, `owner@${B}`, { role: "owner", isAccountOwner: true });
    await db.doc("trialRequests/r1").set({ product: "bridal", name: "Ana", contact: "0917 000 0000", status: "new" });
    await db.doc("trialRequestLimits/k1").set({ count: 1 });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("trial requests are server-only", () => {
  it("nobody reads or lists them", async () => {
    for (const who of [dbAs(env, `owner@${B}`), dbAnon(env)]) {
      await assertFails(who.doc("trialRequests/r1").get());
      await assertFails(who.collection("trialRequests").get());
      await assertFails(who.doc("trialRequestLimits/k1").get());
    }
  });
  it("nobody writes one or resets a limit", async () => {
    await assertFails(dbAnon(env).doc("trialRequests/r2").set({ product: "bridal", name: "Bot", contact: "x", status: "new" }));
    await assertFails(dbAs(env, `owner@${B}`).doc("trialRequests/r1").update({ status: "done" }));
    await assertFails(dbAnon(env).doc("trialRequestLimits/k1").set({ count: 0 }));
  });
});
