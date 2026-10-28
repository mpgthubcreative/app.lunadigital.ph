// Wedding photo retention (2026-10-28 incident): a replaced or removed
// cover / design / gallery photo is kept 30 days, server-only, and Luna can
// restore it; Reset invitation keeps every photo it removes. Expired copies
// are pruned on the next change.
import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { listRetained, restoreRetained, PHOTO_RETENTION_DAYS } from "../../netlify/functions/_lib/photo-retention.js";

const NOW = new Date("2026-10-28T08:00:00Z");
const W = "wed-retain";
const jpeg = (n) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100 + n, n)]).toString("base64")}`;
let world;
let uid;
beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: W, planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W, trial: true, clock: NOW });
  const o = await ensureAuthUser({ auth: world.auth, email: "o@retain.test", name: "Owner" });
  await addMember({ ...world, businessId: W, uid: o.uid, email: o.email, name: "Owner", roleTemplate: "owner", isAccountOwner: true });
  uid = o.uid;
});
const setup = async (body, now = NOW) => {
  const res = await createWeddingSetupHandler({ getAdmin: async () => world, now: () => now })({ ...request({ uid, businessId: W, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const history = () => [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/${W}/weddingPhotoHistory/`)).map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
const tenant = () => tenantDb(world.db, W);

describe("a replaced or removed photo is kept 30 days", () => {
  it("cover photo: the first save keeps nothing; a change keeps the old one; a removal keeps the last one", async () => {
    await setup({ action: "hero", dataUrl: jpeg(1) });
    expect(history()).toEqual([]);
    await setup({ action: "hero", dataUrl: jpeg(2) });
    await setup({ action: "hero", dataUrl: null });
    const h = history();
    expect(h.map((x) => [x.kind, x.reason, x.dataUrl])).toEqual(expect.arrayContaining([["hero", "replaced", jpeg(1)], ["hero", "removed", jpeg(2)]]));
    expect(h).toHaveLength(2);
    const kept = h[0];
    expect(new Date(kept.expiresAt).getTime() - new Date(kept.retainedAt).getTime()).toBe(PHOTO_RETENTION_DAYS * 86_400_000);
    expect(world.db.docs.get(`businesses/${W}/weddingSetup/hero`)).toBeUndefined();
    // Saving the same photo again keeps no duplicate.
    await setup({ action: "hero", dataUrl: jpeg(3) });
    await setup({ action: "hero", dataUrl: jpeg(3) });
    expect(history()).toHaveLength(2);
  });

  it("design photo slots and gallery photos too; Reset invitation keeps every photo it removes", async () => {
    await setup({ action: "photo", slot: "story1", dataUrl: jpeg(4) });
    await setup({ action: "photo", slot: "story1", dataUrl: null });
    const g = (await setup({ action: "galleryAdd", dataUrl: jpeg(5) })).body.photoId;
    await setup({ action: "galleryRemove", photoId: g });
    expect(history().map((x) => [x.kind, x.slot ?? x.photoId, x.reason])).toEqual(expect.arrayContaining([["slot", "story1", "removed"], ["gallery", g, "removed"]]));
    await setup({ action: "hero", dataUrl: jpeg(6) });
    await setup({ action: "photo", slot: "venue", dataUrl: jpeg(7) });
    const before = history().length;
    await setup({ action: "resetInvitation" });
    const reset = history().filter((x) => x.reason === "reset");
    expect(history()).toHaveLength(before + 2);
    expect(reset.map((x) => [x.kind, x.slot ?? null])).toEqual(expect.arrayContaining([["hero", null], ["slot", "venue"]]));
  });

  it("Luna can restore a retained photo (and the photo it replaces is kept in turn)", async () => {
    await setup({ action: "hero", dataUrl: jpeg(1) });
    await setup({ action: "hero", dataUrl: null });
    const [removed] = await listRetained({ tenant: tenant() });
    expect(removed).toMatchObject({ kind: "hero", reason: "removed" });
    await setup({ action: "hero", dataUrl: jpeg(9) });
    await restoreRetained({ db: world.db, tenant: tenant(), historyId: removed.id, actor: { uid: "ops", name: "ops" } });
    expect(world.db.docs.get(`businesses/${W}/weddingSetup/hero`).dataUrl).toBe(jpeg(1));
    expect(history().some((x) => x.dataUrl === jpeg(9) && x.reason === "replaced")).toBe(true);
    expect(history().find((x) => x.id === removed.id).restoredAt).toBeTruthy();
  });

  it("copies older than 30 days are pruned on the next change", async () => {
    await setup({ action: "hero", dataUrl: jpeg(1) });
    await setup({ action: "hero", dataUrl: jpeg(2) });
    expect(history()).toHaveLength(1);
    const later = new Date(NOW.getTime() + 31 * 86_400_000);
    await setup({ action: "hero", dataUrl: jpeg(3) }, later);
    // The 31-day-old copy is gone; the one this change made is kept.
    expect(history().map((x) => x.dataUrl)).toEqual([jpeg(2)]);
  });
});
