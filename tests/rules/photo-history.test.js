// Retained wedding photos (2026-10-28, netlify/functions/_lib/photo-retention.js)
// are server-only: not even the wedding's own Owner reads or writes them, and
// nobody reaches another wedding's.
import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails } from "@firebase/rules-unit-testing";
import { businessDoc, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const B = "ph-rules-a";
const B2 = "ph-rules-b";
beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [B, B2]) {
      await db.doc(`businesses/${bid}`).set(businessDoc(`Biz ${bid}`, "active"));
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
    }
    await db.doc(`businesses/${B}/weddingPhotoHistory/h1`).set({ kind: "hero", dataUrl: "data:image/jpeg;base64,AAAA", reason: "removed" });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("retained wedding photos are server-only", () => {
  it("nobody reads or lists them, the wedding's own Owner included", async () => {
    for (const who of [dbAs(env, `owner@${B}`), dbAs(env, `owner@${B2}`), dbAnon(env)]) {
      await assertFails(who.doc(`businesses/${B}/weddingPhotoHistory/h1`).get());
      await assertFails(who.collection(`businesses/${B}/weddingPhotoHistory`).get());
    }
  });
  it("nobody writes, edits or deletes one", async () => {
    await assertFails(dbAs(env, `owner@${B}`).doc(`businesses/${B}/weddingPhotoHistory/h2`).set({ kind: "hero", dataUrl: "x" }));
    await assertFails(dbAs(env, `owner@${B}`).doc(`businesses/${B}/weddingPhotoHistory/h1`).delete());
    await assertFails(dbAnon(env).doc(`businesses/${B}/weddingPhotoHistory/h1`).update({ restoredAt: 1 }));
  });
});
