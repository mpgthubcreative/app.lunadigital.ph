// Free trial RSVP on real Firestore transactions (2026-10-28: 50 places): 60 guests'
// links made at the same moment on a trial wedding → exactly 50 places
// taken, one lookup per link made, and the counter equals its guests.
import { beforeAll, describe, it, expect, vi } from "vitest";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });
let db, admin, inv, prov, tenantDb;
let run = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const fa = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin } = await fa.getAdmin());
  inv = await import("../../netlify/functions/_lib/invitations.js");
  prov = await import("../../netlify/functions/_lib/provisioning.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
  await prov.seedPlans({ db, admin, overwrite: true });
});

async function trialWedding(guestSizes) {
  run += 1;
  const id = `rsvp-${Date.now().toString(36)}-${run}`;
  await prov.createBusiness({ db, admin, name: `RSVP ${run}`, planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: id, trial: true, clock: new Date() });
  const tenant = tenantDb(db, id);
  await tenant.doc("weddingSetup", "current").set({ coupleNames: "Ana & Ben", weddingDate: "2027-02-14", rsvpEnabled: true, published: true });
  const ids = [];
  for (const [i, partySize] of guestSizes.entries()) {
    const g = tenant.collection("guests").doc(`g${i}x${run}`);
    await g.set({ name: `Guest ${i}`, partySize, rsvp: "awaiting", confirmed: 0, history: [], revision: 1 });
    ids.push(g.id);
  }
  return { id, tenant, ids };
}
const actor = { uid: "owner", name: "Owner", email: "" };

describe("trial RSVP places under contention", () => {
  it("60 single guests at once: exactly 50 links; the rest are refused with the trial limit", async () => {
    const w = await trialWedding(Array(60).fill(1));
    const r = await Promise.allSettled(w.ids.map((guestId) => inv.inviteLink({ db, tenant: w.tenant, guestId, actor, now: new Date() })));
    const made = r.filter((x) => x.status === "fulfilled");
    expect(made).toHaveLength(50);
    for (const x of r.filter((y) => y.status === "rejected")) expect(["trial-rsvp-limit", 10]).toContain(x.reason.code);
    const counter = (await w.tenant.doc("weddingSetup", "trialRsvp").get()).data();
    expect(counter.used).toBe(50);
    expect(Object.keys(counter.guests)).toHaveLength(50);
    const links = await db.collection("invitations").where("businessId", "==", w.id).get();
    expect(links.size).toBe(50);
  });

  it("parties of 3 at once: never more than 50 people (16 parties = 48)", async () => {
    const w = await trialWedding(Array(20).fill(3));
    const r = await Promise.allSettled(w.ids.map((guestId) => inv.inviteLink({ db, tenant: w.tenant, guestId, actor, now: new Date() })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(16);
    expect((await w.tenant.doc("weddingSetup", "trialRsvp").get()).data().used).toBe(48);
  });
});
