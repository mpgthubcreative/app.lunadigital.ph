// The cover (hero) photo, editor → guest (2026-10-28). Carlo & Yanie's
// "blank hero" was not a lost upload: no photo was ever saved, and the
// editor was showing Black & White's own example photo (examples never go
// to guests). A photo the couple saves is stored once (weddingSetup/hero)
// and every guest link of every offered design shows that same photo.
import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createInviteHandler } from "../../netlify/functions/invite.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { OFFERED_TEMPLATE_IDS, getTemplateEntry } from "../../src/modules/wedding/invitation/registry.js";

const NOW = new Date();
const W = "wed-hero";
const W2 = "wed-other";
const PHOTO = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 9)]).toString("base64")}`;
let world;
const u = {};

beforeEach(async () => {
  world = await buildWorld();
  for (const [id, key] of [[W, "owner"], [W2, "other"]]) {
    await createBusiness({ ...world, name: id, planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: id, trial: true, clock: NOW });
    const o = await ensureAuthUser({ auth: world.auth, email: `${key}@hero.test`, name: key });
    await addMember({ ...world, businessId: id, uid: o.uid, email: o.email, name: key, roleTemplate: "owner", isAccountOwner: true });
    u[key] = o.uid;
  }
});
const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const setup = async (body, uid = u.owner, businessId = W) => parse(await createWeddingSetupHandler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) }));
const guests = async (body, uid = u.owner, businessId = W) => parse(await createGuestsHandler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) }));
const invite = async (body) => parse(await createInviteHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) }));

describe("the cover photo the couple saves is the one every guest sees", () => {
  it("no photo saved: the guest gets none (never the design's example photo)", async () => {
    ok(await setup({ action: "save", setup: { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", templateId: "monochrome", rsvpEnabled: true, published: true } }));
    const token = ok(await guests({ action: "inviteLink", guestId: ok(await guests({ action: "create", guest: { name: "Shane", side: "bride", partySize: 2 } }), 201).guestId })).path.split("/").pop();
    const inv = ok(await invite({ action: "view", token })).invitation;
    expect(inv.hero).toBeNull();
    expect(JSON.stringify(inv)).not.toContain(getTemplateEntry("monochrome").sampleAssets.hero);
    expect(world.db.docs.get(`businesses/${W}/weddingSetup/hero`)).toBeUndefined();
  });

  it("saved once: the editor reads it back and the guest link shows the same photo on each offered design", async () => {
    ok(await setup({ action: "save", setup: { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", templateId: "gold", rsvpEnabled: true, published: true } }));
    ok(await setup({ action: "hero", dataUrl: PHOTO }));
    // Refreshing the editor: the stored photo comes back.
    expect(ok(await setup({ action: "get" })).hero).toBe(PHOTO);
    const token = ok(await guests({ action: "inviteLink", guestId: ok(await guests({ action: "create", guest: { name: "Shane", side: "bride", partySize: 2 } }), 201).guestId })).path.split("/").pop();
    expect(OFFERED_TEMPLATE_IDS).toEqual(["gold", "monochrome", "rustic"]);
    for (const id of OFFERED_TEMPLATE_IDS) {
      ok(await setup({ action: "save", setup: { templateId: id } }));
      const inv = ok(await invite({ action: "view", token })).invitation;
      expect(inv.design.config).toMatchObject({ templateId: id, kind: "signature" });
      expect(inv.hero, id).toBe(PHOTO);
    }
    // Removing it: back to no photo (the design's monogram).
    ok(await setup({ action: "hero", dataUrl: null }));
    expect(ok(await invite({ action: "view", token })).invitation.hero).toBeNull();
  });

  it("an upload that isn't an image is refused (the editor keeps showing what was saved)", async () => {
    expect((await setup({ action: "hero", dataUrl: "data:text/html;base64,PHNjcmlwdD4=" })).status).toBe(400);
    expect(ok(await setup({ action: "get" })).hero ?? null).toBeNull();
  });

  it("one wedding's photo never shows on another wedding's links", async () => {
    ok(await setup({ action: "save", setup: { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", templateId: "gold", rsvpEnabled: true, published: true } }));
    ok(await setup({ action: "hero", dataUrl: PHOTO }));
    ok(await setup({ action: "save", setup: { coupleNames: "Ana & Ben", weddingDate: "2027-03-01", templateId: "gold", rsvpEnabled: true, published: true } }, u.other, W2));
    const token = ok(await guests({ action: "inviteLink", guestId: ok(await guests({ action: "create", guest: { name: "Lito", side: "groom", partySize: 1 } }, u.other, W2), 201).guestId }, u.other, W2)).path.split("/").pop();
    expect(ok(await invite({ action: "view", token })).invitation.hero).toBeNull();
    // And the other wedding's owner can't set or read this wedding's photo.
    expect((await setup({ action: "get" }, u.other, W)).status).toBe(403);
  });
});
