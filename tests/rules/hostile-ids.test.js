// Malformed and hostile identifiers: look-alike business ids, ids that
// fail the business-id format, path traversal, and member documents whose
// data claims a different uid than their document id.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { resolvePermissions } from "../../shared/permissions.js";
import { A, B, DOC, createEnv, dbAs } from "./fixture.js";

let env;

// Businesses whose ids break shared/tenancy.js isValidBusinessId. Each has
// an ACTIVE, fully-permissioned membership for ownerA, so the only thing
// that can deny access is the id check itself (defense in depth: the
// server never creates such ids).
const INVALID_IDS = ["ab", "-leading-dash", "_leading-underscore", "has space", "dot.ted", "ünïcode-biz", "x".repeat(65), "semi;colon", "demo-distributor-a%2Fdemo-distributor-b"];

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const ownerMember = { uid: "ownerA", status: "active", roleTemplate: "owner", permissions: resolvePermissions("owner"), isAccountOwner: true };
    for (const bid of INVALID_IDS) {
      await db.doc(`businesses/${bid}`).set({ name: bid, subscription: { status: "active", planId: "growth" } });
      await db.doc(`businesses/${bid}/members/ownerA`).set(ownerMember);
      await db.doc(`businesses/${bid}/orders/${DOC}`).set({ tenant: bid });
    }
    // A member doc in B whose *data* says uid: ownerA, under another doc id.
    await db.doc(`businesses/${B}/members/imposter`).set({ ...ownerMember, uid: "ownerA", email: "ownera@rules.test" });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("business id format is enforced by the rules", () => {
  for (const bid of INVALID_IDS) {
    it(`refuses ${JSON.stringify(bid.length > 20 ? `${bid.slice(0, 12)}…(${bid.length})` : bid)} even with an active membership`, async () => {
      const db = dbAs(env, "ownerA");
      await assertFails(db.doc(`businesses/${bid}`).get());
      await assertFails(db.doc(`businesses/${bid}/orders/${DOC}`).get());
      await assertFails(db.collection(`businesses/${bid}/orders`).get());
    });
  }

  it("a 64-character valid id is still subject to membership", async () => {
    await assertFails(dbAs(env, "ownerA").doc(`businesses/${"y".repeat(64)}/orders/${DOC}`).get());
  });
});

describe("look-alike ids do not resolve to Business A or B", () => {
  const lookAlikes = [B.toUpperCase(), `${B} `, ` ${B}`, B.replace("o", "ο"), `${B}​`, B.replace(/-/g, "_"), `${A}-`, `${A}x`];
  for (const bid of lookAlikes) {
    it(`${JSON.stringify(bid)} is refused`, async () => {
      const db = dbAs(env, "ownerA");
      await assertFails(db.doc(`businesses/${bid}`).get());
      await assertFails(db.doc(`businesses/${bid}/orders/${DOC}`).get());
    });
  }
});

describe("path traversal and malformed paths never reach B", () => {
  it.each([
    `businesses/${A}/../${B}/orders/${DOC}`,
    `businesses/${A}/..%2F${B}/orders`,
    `businesses//${B}/orders/${DOC}`,
    `businesses/./${B}/orders/${DOC}`,
    `businesses/${B}/./orders/${DOC}`,
  ])("%s", async (path) => {
    const db = dbAs(env, "ownerA");
    const segments = path.split("/").filter(Boolean).length;
    const attempt = Promise.resolve().then(() => (segments % 2 === 0 ? db.doc(path).get() : db.collection(path).get()));
    // Either the SDK rejects the path outright or the rules deny it; both
    // are failures, and neither returns B's data.
    await expect(attempt).rejects.toBeDefined();
  });

  it("'.', '..' and '__name__'-style ids are rejected", async () => {
    const db = dbAs(env, "ownerA");
    for (const bid of [".", "..", "__luna__"]) {
      await expect(Promise.resolve().then(() => db.doc(`businesses/${bid}/orders/${DOC}`).get())).rejects.toBeDefined();
    }
  });
});

describe("membership is keyed by the document id = auth uid", () => {
  it("a B member doc whose data claims uid 'ownerA' grants ownerA nothing", async () => {
    const db = dbAs(env, "ownerA");
    await assertFails(db.doc(`businesses/${B}`).get());
    await assertFails(db.doc(`businesses/${B}/orders/${DOC}`).get());
  });

  it("but signing in AS that doc id would (shows the doc id is what counts)", async () => {
    await assertSucceeds(dbAs(env, "imposter").doc(`businesses/${B}/orders/${DOC}`).get());
  });

  it("a uid containing path characters cannot escape its member doc", async () => {
    // Auth uids are opaque strings; one shaped like a path must not
    // resolve to someone else's membership.
    for (const uid of [`../../${B}/members/ownerB`, "ownerB/", "ownerB/../ownerB"]) {
      await assertFails(dbAs(env, uid).doc(`businesses/${B}/orders/${DOC}`).get());
    }
  });
});
