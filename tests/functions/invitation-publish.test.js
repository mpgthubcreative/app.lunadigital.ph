// Template-first invitations (2026-10-25): a NEW invitation starts
// unpublished while the couple personalizes it; guests' links say "not
// published yet" until Publish, which needs the real names and date (a
// design's sample content is never stored and never reaches a guest).
// Weddings set up before have no flag and stay live. Only the three
// offered designs can be newly chosen; older ones keep rendering.

import { describe, it, expect, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createInviteHandler } from "../../netlify/functions/invite.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request, roomForTeam } from "../helpers/tenants.js";
import { TEMPLATE_REGISTRY, OFFERED_TEMPLATE_IDS, getTemplateEntry } from "../../shared/invitation-design.js";
import { previewSetup } from "../../src/modules/wedding/invitation/samples.js";

const NOW = new Date("2026-10-25T03:00:00Z");
const W = "wed-publish";
const T = "wed-trialing";
let world;
const u = {};
beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "New Wedding", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W });
  await roomForTeam(world, W);
  await createBusiness({ ...world, name: "Trial Wedding", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: T, trial: true, clock: NOW });
  for (const [key, businessId] of [["owner", W], ["trial", T]]) {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@publish.test`, name: key });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key, roleTemplate: "owner", isAccountOwner: true });
    u[key] = x.uid;
  }
});
const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const call = async (handler, body, uid = u.owner, businessId = W) => {
  const res = await handler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const setup = (body, uid, businessId) => call(createWeddingSetupHandler, body, uid, businessId);
const guests = (body) => call(createGuestsHandler, body);
const invite = async (body) => {
  const res = await createInviteHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const stored = (businessId = W) => world.db.docs.get(`businesses/${businessId}/weddingSetup/current`);
const SAMPLE_WORDS = /Nicky|Magnolia|Charleston|rainy October|hello@nickyandsam|\/invitations\/samples\//;

describe("a new invitation: choose → personalize → Publish", () => {
  it("unpublished until Publish: links can be prepared, guests see 'not published yet'; Publish needs the real names and date", async () => {
    // The editor's first save: the chosen design, unpublished.
    ok(await setup({ action: "save", setup: { templateId: "gold", published: false } }));
    expect(stored()).toMatchObject({ templateId: "gold", published: false });
    // Publish with nothing real: refused, nothing changes.
    const early = await setup({ action: "save", setup: { published: true } });
    expect(early.status).toBe(409);
    expect(early.body.message).toMatch(/Add the couple's names and the wedding date before publishing/);
    expect(stored().published).toBe(false);
    // The couple adds their names and date (inline sheets); a link is made.
    ok(await setup({ action: "save", setup: { partner1Name: "Camille", partner2Name: "Carlo", coupleNames: "Camille & Carlo" } }));
    ok(await setup({ action: "save", setup: { weddingDate: "2027-02-14", rsvpEnabled: true } }));
    const g = ok(await guests({ action: "create", guest: { name: "Maria Santos", side: "bride", partySize: 2 } }), 201).guestId;
    const token = ok(await guests({ action: "inviteLink", guestId: g })).path.split("/").pop();
    const hidden = await invite({ action: "view", token });
    expect(hidden.status).toBe(404);
    expect(hidden.body.message).toBe("This invitation isn't published yet. Please check back soon.");
    expect((await invite({ action: "respond", token, rsvp: { status: "declined" } })).status).toBe(404);
    // Publish: the same link opens, with only real content.
    ok(await setup({ action: "save", setup: { published: true } }));
    const inv = ok(await invite({ action: "view", token })).invitation;
    expect(inv.wedding).toMatchObject({ coupleNames: "Camille & Carlo", weddingDate: "2027-02-14", story: null, schedule: null, ceremonyVenue: null });
    expect(inv.hero).toBeNull();
    expect(inv.photos).toEqual({});
    expect(JSON.stringify(inv)).not.toMatch(SAMPLE_WORDS);
    // A live invitation is never taken down by a save.
    ok(await setup({ action: "save", setup: { published: false, city: "Tagaytay" } }));
    expect(stored()).toMatchObject({ published: true, city: "Tagaytay" });
    expect((await invite({ action: "view", token })).status).toBe(200);
  });
  it("an older wedding (no flag) stays live; switching to a new design keeps it live", async () => {
    world.db.docs.set(`businesses/${W}/weddingSetup/current`, { coupleNames: "Ana & Ben", weddingDate: "2027-03-01", rsvpEnabled: true, templateId: "classic" });
    const g = ok(await guests({ action: "create", guest: { name: "Lito", side: "groom", partySize: 1 } }), 201).guestId;
    const token = ok(await guests({ action: "inviteLink", guestId: g })).path.split("/").pop();
    expect(ok(await invite({ action: "view", token })).invitation.design.config.templateId).toBe("classic");
    // Saving the current older design is fine; choosing another older one is not.
    ok(await setup({ action: "save", setup: { templateId: "classic", city: "Cebu" } }));
    expect((await setup({ action: "save", setup: { templateId: "modern" } })).status).toBe(400);
    ok(await setup({ action: "save", setup: { templateId: "monochrome" } }));
    expect(stored().published).toBeUndefined();
    expect(ok(await invite({ action: "view", token })).invitation.design.config.templateId).toBe("monochrome");
  });
  it("the free trial previews only: Publish is refused with the trial message", async () => {
    ok(await setup({ action: "save", setup: { templateId: "rustic", published: false } }, u.trial, T));
    ok(await setup({ action: "save", setup: { coupleNames: "Ana & Ben", weddingDate: "2027-03-01" } }, u.trial, T));
    const r = await setup({ action: "save", setup: { published: true } }, u.trial, T);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("trial-preview");
    expect(stored(T).published).toBe(false);
  });
});

describe("template-owned sample content and photos", () => {
  it("only the three designs are offered, each with its own sample content and photos (files in public/)", () => {
    expect(OFFERED_TEMPLATE_IDS).toEqual(["gold", "monochrome", "rustic"]);
    for (const id of OFFERED_TEMPLATE_IDS) {
      const e = getTemplateEntry(id);
      expect(e.sampleData).toMatchObject({ partner1Name: "Nicky", partner2Name: "Sam", weddingDate: "2027-06-12", ceremonyVenue: "The Magnolia House" });
      expect(Object.keys(e.sampleAssets).sort()).toEqual(["dressCode", "hero", "story1", "story2", "venue", "when"]);
      for (const url of Object.values(e.sampleAssets)) {
        expect(url).toMatch(/^\/invitations\/samples\/(gold|monochrome|rustic|shared)\/[a-zA-Z0-9]+\.webp$/);
        expect(existsSync(`${process.cwd()}/public${url}`), url).toBe(true);
      }
      // Every editable section maps only to fields / photo slots the design shows.
      for (const s of e.editableSections) for (const f of s.fields) expect(e.uses, `${id} ${s.id} ${f}`).toContain(f);
    }
    // Older designs: no samples (their weddings already have content).
    for (const r of TEMPLATE_REGISTRY.filter((x) => !x.offered)) expect(r.sampleData).toBeNull();
  });
  it("previewSetup: samples fill only empty groups, never mixed with real values, and never change the real record", () => {
    const real = Object.freeze({ coupleNames: "Ana & Ben", ceremonyVenue: "St. Michael Parish", story: "", schedule: [] });
    const out = previewSetup(getTemplateEntry("gold"), real, { hero: null, photos: { story1: "data:image/jpeg;base64,AAAA" } });
    expect(real).toEqual({ coupleNames: "Ana & Ben", ceremonyVenue: "St. Michael Parish", story: "", schedule: [] });
    // Names and the venue group are real: no sample names / address / times beside them.
    expect(out.setup).toMatchObject({ coupleNames: "Ana & Ben", ceremonyVenue: "St. Michael Parish" });
    expect(out.setup.partner1Name).toBeUndefined();
    expect(out.setup.ceremonyAddress).toBeUndefined();
    expect(out.setup.ceremonyTime).toBeUndefined();
    // Empty groups show the design's example.
    expect(out.setup.story).toMatch(/rainy October/);
    expect(out.setup.schedule).toHaveLength(5);
    expect(out.sampled.map((x) => x.id)).toEqual(["date", "city", "gettingThere", "welcome", "story", "schedule", "dress", "goodToKnow", "rsvp", "closing"]);
    // Photos: the couple's own where set, the design's elsewhere.
    expect(out.photos.story1).toBe("data:image/jpeg;base64,AAAA");
    expect(out.photos.story2).toBe("/invitations/samples/gold/story2.webp");
    expect(out.hero).toBe("/invitations/samples/gold/hero.webp");
    expect(out.sampledPhotos.map((x) => x.id)).toEqual(["hero", "story2", "when", "venue", "dressCode"]);
    // A design without samples: the real record as it is.
    expect(previewSetup(getTemplateEntry("classic"), real).setup).toEqual(real);
  });
});
