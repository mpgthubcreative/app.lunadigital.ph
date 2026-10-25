// Wedding Setup → Preview → the guest's invitation: one data contract
// (2026-10-21). The guest's link, the Owner's Wedding Setup Preview and
// Super Admin's preview get the same wedding details, photos and design
// from the same loader (shared invitationData + liveDesignFor /
// previewDesign); only live / draft and the guest (real / sample) differ.
// Nothing the couple saved is silently dropped: the Luna Standard page
// shows Our story, Gallery, FAQ and the closing line when they're added.

import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createInviteHandler } from "../../netlify/functions/invite.js";
import { createInvitationDesignHandler } from "../../netlify/functions/invitation-design.js";
import { createBusiness, addMember, ensureAuthUser, setOperator } from "../../netlify/functions/_lib/provisioning.js";
import { INVITATION_CONTENT_FIELDS, STANDARD_TEMPLATE_IDS, invitationData } from "../../shared/invitation-design.js";
import { SETUP_FIELDS } from "../../shared/wedding.js";

const NOW = new Date();
let world;
const u = {};
const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const as = (handler, uid, businessId) => async (body) => parse(await handler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) }));
const invite = async (body) => parse(await createInviteHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) }));

// Every Wedding Setup field a couple can fill in (the form's fields).
const FULL = {
  coupleNames: "Carlo & Yanie",
  weddingDate: "2027-02-14",
  ceremonyTime: "15:00",
  ceremonyVenue: "San Agustin Church",
  ceremonyAddress: "General Luna St, Intramuros, Manila",
  ceremonyMap: "https://maps.app.goo.gl/ceremony",
  receptionTime: "18:00",
  receptionVenue: "Garden Pavilion",
  receptionAddress: "Roxas Blvd, Manila",
  receptionMap: "https://maps.app.goo.gl/reception",
  dressCode: "Formal, garden colours",
  welcomeMessage: "Join us as we begin forever.",
  rsvpDeadline: "2027-01-15",
  rsvpEnabled: true,
  closeAfterDeadline: true,
  weddingSlug: "carloyanie-preview",
  story: "We met at a friend's wedding.",
  faq: [{ q: "Is there parking?", a: "Yes, at the church." }, { q: "Kids?", a: "Adults only, please." }],
  footerNote: "With love, Carlo & Yanie",
};
const JPEG = (n) => `data:image/jpeg;base64,/9j/4AAQSkZJRg${"A".repeat(n)}`;

async function wedding(businessId, planId) {
  await createBusiness({ ...world, name: `Wedding ${businessId}`, planId, workspaceTemplateId: "bridal-expense", businessId, clock: NOW });
  const o = await ensureAuthUser({ auth: world.auth, email: `owner@${businessId}.test`, name: "Camille" });
  await addMember({ ...world, businessId, uid: o.uid, email: o.email, name: "Camille", roleTemplate: "owner", isAccountOwner: true });
  return o.uid;
}

beforeEach(async () => {
  world = await buildWorld();
  u.custom = await wedding("wed-custom", "bridal-plus");
  u.basic = await wedding("wed-basic", "bridal-basic");
  const op = await ensureAuthUser({ auth: world.auth, email: "ops@luna.test", name: "Ops" });
  await setOperator({ ...world, email: op.email, status: "active", reason: "test operator" });
  u.ops = op.uid;
});

describe("Wedding Setup fields → the invitation (audit)", () => {
  it("every content field the couple fills in reaches the invitation contract; the rest drive RSVP, the link or the template", () => {
    const content = new Set(INVITATION_CONTENT_FIELDS);
    const notContent = { rsvpEnabled: "rsvpOpen", closeAfterDeadline: "rsvpOpen", weddingSlug: "path", templateId: "design", templateOptions: "design (wording / accent of the design shown: options)", showTable: "not on the form (reserved)" };
    for (const f of SETUP_FIELDS) expect(content.has(f) || f in notContent, f).toBe(true);
    const out = invitationData({ setup: FULL, guest: {}, rsvpOpen: true });
    for (const f of INVITATION_CONTENT_FIELDS) expect(out.wedding[f], f).toEqual(FULL[f] ?? null);
  });
});

describe("Luna Bridal Custom, design not published yet (guests see Luna Standard)", () => {
  let token;
  const setup = () => as(createWeddingSetupHandler, u.custom, "wed-custom");
  beforeEach(async () => {
    ok(await setup()({ action: "save", setup: FULL }));
    ok(await setup()({ action: "hero", dataUrl: JPEG(40) }));
    for (const n of [10, 20, 30]) ok(await setup()({ action: "galleryAdd", dataUrl: JPEG(n) }));
    const g = ok(await as(createGuestsHandler, u.custom, "wed-custom")({ action: "create", guest: { name: "Santos Family", side: "bride", partySize: 3 } }), 201).guestId;
    token = ok(await as(createGuestsHandler, u.custom, "wed-custom")({ action: "inviteLink", guestId: g })).path.split("/").pop();
  });

  it("the guest's link carries every detail, the cover photo and all three gallery photos", async () => {
    const v = ok(await invite({ action: "view", token })).invitation;
    expect(v.design).toBeNull();
    expect(v.gallery).toEqual([JPEG(10), JPEG(20), JPEG(30)]);
    expect(v.hero).toBe(JPEG(40));
    for (const f of INVITATION_CONTENT_FIELDS) expect(v.wedding[f], f).toEqual(FULL[f] ?? null);
    expect(v.guest.name).toBe("Santos Family");
  });

  it("the Owner's Preview and Super Admin's preview get exactly what the guest's link gets (only the guest differs)", async () => {
    const v = ok(await invite({ action: "view", token })).invitation;
    const owner = ok(await setup()({ action: "preview", which: "live" }));
    expect({ design: owner.design, gallery: owner.gallery }).toEqual({ design: v.design, gallery: v.gallery });
    const sa = ok(await as(createInvitationDesignHandler, u.ops)({ action: "sample", businessId: "wed-custom", which: "live" })).invitation;
    const { guest: g1, path, ...guestView } = v;
    const { guest: g2, sample, ...adminView } = sa;
    expect(adminView).toEqual(guestView);
    expect(g2.name).toBe("Sample Guest");
  });

  it("Draft / Published unchanged: a draft design is previewed (with the gallery) but guests keep the live invitation until Publish", async () => {
    const design = as(createInvitationDesignHandler, u.ops);
    ok(await design({ action: "saveDraft", businessId: "wed-custom", config: { templateId: "modern" } }));
    const draft = ok(await setup()({ action: "preview", which: "draft" }));
    expect(draft.design.config.templateId).toBe("modern");
    expect(draft.gallery).toHaveLength(3); // Modern shows the Gallery
    expect(ok(await invite({ action: "view", token })).invitation.design).toBeNull();
    ok(await design({ action: "publish", businessId: "wed-custom" }));
    const live = ok(await invite({ action: "view", token })).invitation;
    expect(live.design.config.templateId).toBe("modern");
    expect(live.gallery).toHaveLength(3);
    expect(ok(await setup()({ action: "preview", which: "live" })).design.config.templateId).toBe("modern");
  });
});

describe("Luna Bridal (Standard templates): the Owner's Preview of the template on screen", () => {
  const setup = () => as(createWeddingSetupHandler, u.basic, "wed-basic");
  it("previews each Standard template before saving; the saved choice and details stay as they are", async () => {
    ok(await setup()({ action: "save", setup: { ...FULL, story: null, faq: [], footerNote: null, weddingSlug: "carloyanie-basic", templateId: "classic" } }));
    const before = JSON.stringify(world.db.docs.get("businesses/wed-basic/weddingSetup/current"));
    for (const id of STANDARD_TEMPLATE_IDS) {
      const look = ok(await setup()({ action: "preview", which: "live", templateId: id }));
      if (id === "standard") expect(look.design).toBeNull();
      else expect(look.design.config.templateId, id).toBe(id);
    }
    expect(JSON.stringify(world.db.docs.get("businesses/wed-basic/weddingSetup/current"))).toBe(before);
    // A Custom-only template can't be previewed as a Standard choice.
    expect(ok(await setup()({ action: "preview", which: "live", templateId: "garden" })).design.config.templateId).toBe("classic");
  });
});
