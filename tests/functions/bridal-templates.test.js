// Bridal invitation templates + the free trial (2026-10-21). Templates live
// in src/modules/wedding/invitation/templates/{id}/ and customized/{id}/ (registry.js); a wedding
// stores only its templateId. During the free trial the couple chooses a
// Standard template, fills in the details, publishes and sends real RSVP
// links to up to 20 guests (2026-10-26; tests/functions/trial-rsvp.test.js).
// Switching template never changes a guest's link.

import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createInviteHandler } from "../../netlify/functions/invite.js";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { createSubscriptionHandler } from "../../netlify/functions/subscription.js";
import { createInvitationDesignHandler } from "../../netlify/functions/invitation-design.js";
import { createBusiness, addMember, ensureAuthUser, setOperator } from "../../netlify/functions/_lib/provisioning.js";
import { TEMPLATES, TEMPLATE_IDS, STANDARD_TEMPLATE_IDS, SECTION_IDS, resolveDesign, validateDesignConfig } from "../../shared/invitation-design.js";
import { businessDate } from "../../shared/metrics.js";

const NOW = new Date();
const TODAY = businessDate("Asia/Manila", NOW);
const W = "wed-trial";
let world;
const u = {};

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Carlo & Yanie", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W, trial: true, clock: NOW });
  const o = await ensureAuthUser({ auth: world.auth, email: "camille@wed.test", name: "Camille" });
  await addMember({ ...world, businessId: W, uid: o.uid, email: o.email, name: "Camille", roleTemplate: "owner", isAccountOwner: true });
  u.owner = o.uid;
  const op = await ensureAuthUser({ auth: world.auth, email: "ops@luna.test", name: "Ops" });
  await setOperator({ ...world, email: op.email, status: "active", reason: "test operator" });
  u.ops = op.uid;
});

const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const setup = async (body) => parse(await createWeddingSetupHandler(deps())({ ...request({ uid: u.owner, businessId: W, method: "POST" }), body: JSON.stringify(body) }));
const guests = async (body) => parse(await createGuestsHandler(deps())({ ...request({ uid: u.owner, businessId: W, method: "POST" }), body: JSON.stringify(body) }));
const invite = async (body) => parse(await createInviteHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) }));
const op = async (body) => parse(await createOperatorHandler(deps())({ ...request({ uid: u.ops }), httpMethod: "POST", body: JSON.stringify(body) }));
const design = async (body) => parse(await createInvitationDesignHandler(deps())({ ...request({ uid: u.ops, method: "POST" }), body: JSON.stringify(body) }));
const sub = async (body) => parse(await createSubscriptionHandler(deps())({ ...request({ uid: u.owner, businessId: W, method: "POST" }), body: JSON.stringify(body) }));

describe("the template registry", () => {
  it("Luna Standard, Classic, Modern, Romantic, Editorial for the Owner; Garden kept for Custom designs; every template complete", () => {
    expect(STANDARD_TEMPLATE_IDS).toEqual(["standard", "classic", "modern", "romantic", "editorial", "gold", "monochrome", "rustic"]);
    expect(TEMPLATE_IDS).toEqual([...STANDARD_TEMPLATE_IDS, "garden"]);
    for (const id of TEMPLATE_IDS) {
      const t = TEMPLATES[id];
      expect(t.label, id).toBeTruthy();
      expect(Object.keys(t.theme).sort(), id).toEqual(["accent", "accentText", "background", "bodyFont", "border", "card", "headingFont", "muted", "scriptFont", "text"].sort());
      expect(t.sections.order.slice().sort(), id).toEqual([...SECTION_IDS].sort());
      expect(t.sections.visible.rsvp, id).toBe(true);
      expect(validateDesignConfig({ templateId: id })).toEqual({ templateId: id });
      expect(resolveDesign({ templateId: id }).templateId).toBe(id);
    }
  });
});

describe("Bridal free trial: choose, fill in, preview; publish once paid", () => {
  it("the Owner picks one of the three offered designs (stored as templateId only); older and Custom-only templates are refused as new choices", async () => {
    // 2026-10-25: only Gold Elegance, Black & White and Rustic Garden are offered.
    expect((await setup({ action: "save", setup: { coupleNames: "Carlo & Yanie", templateId: "romantic" } })).status).toBe(400);
    ok(await setup({ action: "save", setup: { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", rsvpEnabled: true, weddingSlug: "carloyanieforever", templateId: "rustic" } }));
    expect(world.db.docs.get(`businesses/${W}/weddingSetup/current`)).toMatchObject({ templateId: "rustic" });
    // The template source (and its sample content) is never copied into the wedding.
    expect(JSON.stringify(world.db.docs.get(`businesses/${W}/weddingSetup/current`))).not.toMatch(/#b4532a|Young Serif|Nicky|Magnolia/);
    expect((await setup({ action: "save", setup: { templateId: "garden" } })).status).toBe(400);
    expect((await setup({ action: "save", setup: { templateId: "<script>" } })).status).toBe(400);
    // Super Admin's Invitation card: the selected template; preview only.
    const inv = ok(await op({ action: "business", businessId: W })).invitation;
    expect(inv).toMatchObject({ type: "standard", templateId: "rustic", templateLabel: "Rustic Garden", trialPreviewOnly: true });
    // Super Admin's sample preview shows the chosen template.
    expect(ok(await design({ action: "sample", businessId: W, which: "live" })).invitation.design.config).toMatchObject({ templateId: "rustic", theme: { accent: "#b4532a" } });
  });

  it("during the trial a guest link works (RSVP trial); after paying, the same link stays and template changes keep it", async () => {
    ok(await setup({ action: "save", setup: { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", rsvpEnabled: true, weddingSlug: "carloyanieforever", templateId: "gold" } }));
    const g = ok(await guests({ action: "create", guest: { name: "Santos Family", side: "bride", partySize: 4 } }), 201).guestId;
    const first = ok(await guests({ action: "inviteLink", guestId: g }));
    expect(first.trialRsvp).toEqual({ used: 4, limit: 20 });
    // Continue with Luna Bridal (₱499 for 3 months): choose, Luna records the payment.
    const chosen = ok(await sub({ action: "choose", termMonths: 3 }));
    expect(chosen.invoice.amountDue).toBe(49900);
    ok(await op({ action: "recordPayment", businessId: W, payment: { paymentDate: TODAY } }));
    expect(world.db.docs.get(`businesses/${W}`).subscription.trialStatus).toBe("converted");
    const path = ok(await guests({ action: "inviteLink", guestId: g })).path;
    const token = path.split("/").pop();
    expect(path).toBe(first.path);
    expect(path).toBe(`/w/carloyanieforever/rsvp/${token}`);
    const v1 = ok(await invite({ action: "view", token })).invitation;
    expect(v1.design).toMatchObject({ standard: true, config: { templateId: "gold", kind: "signature" } });
    expect(v1.guest.name).toBe("Santos Family");
    // A new template: the same link shows it.
    ok(await setup({ action: "save", setup: { templateId: "monochrome" } }));
    const v2 = ok(await invite({ action: "view", token })).invitation;
    expect(v2.design.config.templateId).toBe("monochrome");
    expect(ok(await guests({ action: "inviteLink", guestId: g })).path).toBe(path);
    // An older wedding on Luna Standard (stored before): still the original page, same link.
    expect((await setup({ action: "save", setup: { templateId: "standard" } })).status).toBe(400);
    world.db.docs.set(`businesses/${W}/weddingSetup/current`, { ...world.db.docs.get(`businesses/${W}/weddingSetup/current`), templateId: null });
    expect(ok(await invite({ action: "view", token })).invitation.design).toBeNull();
    ok(await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 3 } }));
  });

  it("a link of a free trial that ENDED unpaid isn't opened (not published yet) until it's paid", async () => {
    ok(await setup({ action: "save", setup: { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", rsvpEnabled: true, published: true } }));
    const g = ok(await guests({ action: "create", guest: { name: "Reyes Family", side: "groom", partySize: 2 } }), 201).guestId;
    const token = ok(await guests({ action: "inviteLink", guestId: g })).path.split("/").pop();
    ok(await invite({ action: "view", token }));
    const b = world.db.docs.get(`businesses/${W}`);
    world.db.docs.set(`businesses/${W}`, { ...b, subscription: { ...b.subscription, trialStartedAt: "2020-01-01", trialEndsAt: "2020-01-30" } });
    const r = await invite({ action: "view", token });
    expect(r.status).toBe(404);
    expect(r.body.message).toBe("This invitation isn't published yet. Please check back soon.");
    expect((await invite({ action: "respond", token, rsvp: { status: "declined" } })).status).toBe(404);
  });
});

describe("Luna Bridal Custom: Super Admin's design, Draft / Publish", () => {
  it("the Invitation card shows the published design's template; a draft on another template waits for Publish", async () => {
    await createBusiness({ ...world, name: "Custom Wedding", planId: "bridal-plus", workspaceTemplateId: "bridal-expense", businessId: "wed-custom", clock: NOW });
    ok(await design({ action: "saveDraft", businessId: "wed-custom", config: { templateId: "garden" } }));
    ok(await design({ action: "publish", businessId: "wed-custom" }));
    ok(await design({ action: "saveDraft", businessId: "wed-custom", config: { templateId: "modern" } }));
    const inv = ok(await op({ action: "business", businessId: "wed-custom" })).invitation;
    expect(inv).toMatchObject({ type: "custom", status: "published", templateId: "garden", templateLabel: "Garden", draftTemplateId: "modern", unpublishedChanges: true, trialPreviewOnly: false });
  });
});
