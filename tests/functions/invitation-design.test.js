// Luna Bridal / Luna Bridal+ invitations: one shared engine, a per-business
// design (draft → ready → published), plan-based entitlement, a
// non-destructive upgrade / downgrade, Super Admin only design edits, and
// guest links / RSVPs untouched by any of it.

import { describe, it, expect, beforeEach } from "vitest";
import { createInvitationDesignHandler } from "../../netlify/functions/invitation-design.js";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createInviteHandler } from "../../netlify/functions/invite.js";
import { createBackupHandler } from "../../netlify/functions/backup.js";
import { createBusiness, addMember, ensureAuthUser, setOperator, assignPlan } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { invitationLevelOf, resolveDesign, validateDesignConfig, invitationStatus, TEMPLATES } from "../../shared/invitation-design.js";
import { readXlsx } from "../../shared/xlsx.js";

const NOW = new Date("2026-10-16T04:00:00Z");
const W = "biz-wed";
const W2 = "biz-wed-2";
const PNG = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 3)]).toString("base64")}`;
const SVG_OK = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>').toString("base64")}`;
const SVG_BAD = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64")}`;
let world;
let u;

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Reyes-Prado Wedding", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W });
  await createBusiness({ ...world, name: "Cruz Wedding", planId: "bridal-plus", workspaceTemplateId: "bridal-expense", businessId: W2 });
  u = {};
  const add = async (key, businessId, role) => {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@design.test`, name: key });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  };
  await add("camille", W, "owner");
  await add("other", W2, "owner");
  const op = await ensureAuthUser({ auth: world.auth, email: "ops@luna.test", name: "ops" });
  await setOperator({ ...world, email: op.email, status: "active", reason: "test operator" });
  u.ops = op.uid;
});

const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const design = async (body, uid = u.ops) => parse(await createInvitationDesignHandler(deps())({ ...request({ uid, method: "POST" }), body: JSON.stringify(body) }));
const H = { guests: createGuestsHandler, setup: createWeddingSetupHandler };
const owner = async (kind, body, uid = u.camille, businessId = W) => parse(await H[kind](deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) }));
const invite = async (body) => parse(await createInviteHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) }));
const doc = (p, businessId = W) => world.db.docs.get(`businesses/${businessId}/${p}`);
const snapshotOf = (prefixes) => JSON.stringify([...world.db.docs.entries()].filter(([k]) => prefixes.some((p) => k.startsWith(p))).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { ...v, updatedAt: undefined }]));

// A wedding with content, a slug, a guest party, its link and an RSVP.
async function wedding(businessId = W, uid = u.camille) {
  ok(await owner("setup", { action: "save", setup: { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", rsvpEnabled: true, weddingSlug: businessId === W ? "carloyanieforever" : "cruz-wedding", story: "We met at a wedding.", faq: [{ q: "Parking?", a: "Yes, at the venue." }] } }, uid, businessId));
  const g = ok(await owner("guests", { action: "create", guest: { name: "Sanrah", category: "friends", side: "bride", partySize: 5 } }, uid, businessId), 201).guestId;
  ok(await owner("guests", { action: "addMember", guestId: g, name: "Anna" }, uid, businessId), 201);
  const path = ok(await owner("guests", { action: "inviteLink", guestId: g }, uid, businessId)).path;
  const token = path.split("/").pop();
  ok(await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 3 } }));
  return { g, path, token };
}

describe("plans and the design model", () => {
  it("Luna Bridal = Standard invitation, Luna Bridal+ = Customized (by plan, never by tenant)", () => {
    expect([invitationLevelOf("bridal-basic"), invitationLevelOf("bridal-plus"), invitationLevelOf("growth"), invitationLevelOf(undefined)]).toEqual(["standard", "custom", "standard", "standard"]);
    expect(resolveDesign(null).templateId).toBe("standard");
    expect(resolveDesign({}).theme).toEqual(TEMPLATES.standard.theme); // existing weddings: the Standard look, no data needed
    expect(invitationStatus({ planId: "bridal-basic", design: null })).toMatchObject({ level: "standard", live: "standard", hasDraft: false, preservedCustom: false });
  });

  it("design configs are constrained: colours, allow-listed fonts, enums, every section once, RSVP always shown; no raw CSS / HTML", () => {
    expect(validateDesignConfig({ templateId: "garden", theme: { accent: "#4F6F52", headingFont: "Playfair Display" }, layout: { align: "left" } })).toEqual({ templateId: "garden", theme: { accent: "#4f6f52", headingFont: "Playfair Display" }, layout: { align: "left" } });
    expect(() => validateDesignConfig({ css: "body{display:none}" })).toThrow(/unknown setting css/);
    expect(() => validateDesignConfig({ theme: { accent: "red; background:url(x)" } })).toThrow(/a colour like/);
    expect(() => validateDesignConfig({ theme: { bodyFont: "Comic Sans" } })).toThrow(/listed fonts/);
    expect(() => validateDesignConfig({ sections: { order: ["hero", "rsvp"] } })).toThrow(/every section once/);
    expect(() => validateDesignConfig({ sections: { visible: { rsvp: false } } })).toThrow(/RSVP section can't be hidden/);
    expect(() => validateDesignConfig({ texts: { scriptLine: "<b>x</b>".repeat(20) } })).toThrow(/up to 60/);
  });
});

describe("Luna Super Admin edits one wedding's design; the couple can't", () => {
  it("only active operators reach /api/invitation-design (a wedding Owner gets 403)", async () => {
    expect((await design({ action: "get", businessId: W }, u.camille)).status).toBe(403);
    const w = ok(await design({ action: "get", businessId: W }));
    expect(w.business).toMatchObject({ id: W, planId: "bridal-basic" });
    expect(w.draft.config).toEqual({ templateId: "standard" }); // starts from the Standard design
    expect(w.status).toMatchObject({ level: "standard", live: "standard" });
    expect((await design({ action: "get", businessId: "biz-a" })).body.error).toBe("not-available"); // not a wedding
  });

  it("Luna Bridal: a draft can be prepared but not published; the Standard invitation stays live", async () => {
    const { token } = await wedding();
    ok(await design({ action: "saveDraft", businessId: W, config: { templateId: "classic" } }));
    const pub = await design({ action: "publish", businessId: W });
    expect(pub.status).toBe(409);
    expect(pub.body.message).toMatch(/needs Luna Bridal\+/);
    expect(ok(await invite({ action: "view", token })).invitation.design).toBe(null);
  });
});

describe("Bridal → Bridal+ upgrade, draft → publish, downgrade: appearance only", () => {
  it("the upgrade is entitlement-only: same business, guests, party, tokens, slug, RSVP history; Standard stays live until Publish", async () => {
    const { g, path, token } = await wedding();
    const before = snapshotOf([`businesses/${W}/guests/`, `businesses/${W}/guestInvites/`, "invitations/", "weddingSlugs/", `businesses/${W}/weddingSetup/current`]);
    await assignPlan({ ...world, businessId: W, planId: "bridal-plus", actor: "ops@luna.test", reason: "Client bought Luna Bridal+" });
    expect(snapshotOf([`businesses/${W}/guests/`, `businesses/${W}/guestInvites/`, "invitations/", "weddingSlugs/", `businesses/${W}/weddingSetup/current`])).toBe(before);
    expect(doc(`guests/${g}`)).toMatchObject({ name: "Sanrah", partySize: 5, confirmed: 3, rsvp: "attending" });
    expect(ok(await owner("guests", { action: "inviteLink", guestId: g })).path).toBe(path); // same URL
    const v = ok(await invite({ action: "view", token })).invitation;
    expect(v.design).toBe(null); // Standard still live
    expect(v.guest).toMatchObject({ name: "Sanrah", seats: 5, confirmed: 3 });
    const s = ok(await owner("setup", { action: "get" })).invitation;
    expect(s).toMatchObject({ level: "custom", planName: "Luna Bridal+", live: "standard", hasDraft: false });
  });

  it("Draft → Ready → Publish: guests see the custom design only after Publish; tokens and RSVPs unchanged; versions kept", async () => {
    const { token, g } = await wedding();
    await assignPlan({ ...world, businessId: W, planId: "bridal-plus", actor: "ops", reason: "upgrade" });
    const asset = ok(await design({ action: "uploadAsset", businessId: W, name: "ornament.svg", dataUrl: SVG_OK })).assetId;
    const config = { templateId: "garden", theme: { accent: "#4f6f52", headingFont: "Playfair Display" }, assets: { ornamentTop: asset }, sections: { visible: { story: true, faq: true, entourage: false, gallery: false } } };
    ok(await design({ action: "saveDraft", businessId: W, config }));
    expect(ok(await invite({ action: "view", token })).invitation.design).toBe(null); // draft: Standard still live
    ok(await design({ action: "setState", businessId: W, state: "ready" }));
    expect(ok(await owner("setup", { action: "get" })).invitation).toMatchObject({ live: "standard", draftState: "ready", hasDraft: true });
    // The couple can preview the draft before it goes live.
    expect(ok(await owner("setup", { action: "preview", which: "draft" })).design.config.templateId).toBe("garden");
    const guestBefore = JSON.stringify(doc(`guests/${g}`));
    const tokensBefore = snapshotOf(["invitations/", `businesses/${W}/guestInvites/`]);
    expect(ok(await design({ action: "publish", businessId: W }))).toMatchObject({ published: true, version: 1, live: "custom" });
    const v = ok(await invite({ action: "view", token })).invitation;
    expect(v.design.config).toMatchObject({ templateId: "garden", theme: { accent: "#4f6f52", headingFont: "Playfair Display" } });
    expect(v.design.assets[asset]).toBe(SVG_OK);
    expect(v.wedding).toMatchObject({ story: "We met at a wedding.", faq: [{ q: "Parking?", a: "Yes, at the venue." }] });
    expect(JSON.stringify(doc(`guests/${g}`))).toBe(guestBefore);
    expect(snapshotOf(["invitations/", `businesses/${W}/guestInvites/`])).toBe(tokensBefore);
    expect(ok(await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 4 } })).confirmed).toBe(4); // RSVP keeps working
    // A second version; restore v1 into the draft; Show Standard / custom again.
    ok(await design({ action: "saveDraft", businessId: W, config: { ...config, templateId: "classic" } }));
    expect(ok(await design({ action: "publish", businessId: W })).version).toBe(2);
    ok(await design({ action: "restore", businessId: W, version: 1 }));
    expect(ok(await design({ action: "get", businessId: W })).draft.config.templateId).toBe("garden");
    ok(await design({ action: "useStandard", businessId: W }));
    expect(ok(await invite({ action: "view", token })).invitation.design).toBe(null);
    ok(await design({ action: "useCustom", businessId: W }));
    expect(ok(await invite({ action: "view", token })).invitation.design.config.templateId).toBe("classic");
    expect(doc("auditLog") === undefined).toBe(true);
  });

  it("downgrade keeps the design (Standard shows); upgrading again brings it back without re-publishing", async () => {
    const { token } = await wedding();
    await assignPlan({ ...world, businessId: W, planId: "bridal-plus", actor: "ops", reason: "upgrade" });
    ok(await design({ action: "saveDraft", businessId: W, config: { templateId: "modern" } }));
    ok(await design({ action: "publish", businessId: W }));
    await assignPlan({ ...world, businessId: W, planId: "bridal-basic", actor: "ops", reason: "downgrade" });
    expect(ok(await invite({ action: "view", token })).invitation.design).toBe(null);
    expect(ok(await owner("setup", { action: "get" })).invitation).toMatchObject({ level: "standard", live: "standard", preservedCustom: true });
    expect(doc("invitationDesign/current").published.config.templateId).toBe("modern"); // kept
    await assignPlan({ ...world, businessId: W, planId: "bridal-plus", actor: "ops", reason: "upgrade again" });
    expect(ok(await invite({ action: "view", token })).invitation.design.config.templateId).toBe("modern");
  });

  it("designs are per business: publishing W2 changes nothing for W", async () => {
    const a = await wedding(W);
    const b = await wedding(W2, u.other);
    ok(await design({ action: "saveDraft", businessId: W2, config: { templateId: "classic" } }));
    ok(await design({ action: "publish", businessId: W2 }));
    expect(ok(await invite({ action: "view", token: b.token })).invitation.design.config.templateId).toBe("classic");
    expect(ok(await invite({ action: "view", token: a.token })).invitation.design).toBe(null);
  });
});

describe("design images, content sections, backup", () => {
  it("images: PNG / SVG accepted, SVG with scripts refused; an image used by a design can't be deleted", async () => {
    const png = ok(await design({ action: "uploadAsset", businessId: W, name: "bg.png", dataUrl: PNG })).assetId;
    expect((await design({ action: "uploadAsset", businessId: W, name: "x.svg", dataUrl: SVG_BAD })).body.error).toBe("invalid-asset");
    expect((await design({ action: "uploadAsset", businessId: W, name: "x.html", dataUrl: "data:text/html;base64,PGI+" })).body.error).toBe("invalid-asset");
    expect((await design({ action: "saveDraft", businessId: W, config: { assets: { pageBackground: "missingAsset01" } } })).body.error).toBe("invalid-design");
    ok(await design({ action: "saveDraft", businessId: W, config: { assets: { pageBackground: png } } }));
    expect((await design({ action: "deleteAsset", businessId: W, assetId: png })).body.error).toBe("asset-in-use");
    ok(await design({ action: "saveDraft", businessId: W, config: {} }));
    ok(await design({ action: "deleteAsset", businessId: W, assetId: png }));
  });

  it("gallery and entourage reach the guest only when the live design shows them", async () => {
    const { token, g } = await wedding();
    ok(await owner("guests", { action: "assignRole", guestId: g, role: { id: "principal_sponsor" } }));
    ok(await owner("setup", { action: "galleryAdd", dataUrl: "data:image/jpeg;base64,/9j/4AAQ" }));
    await assignPlan({ ...world, businessId: W, planId: "bridal-plus", actor: "ops", reason: "upgrade" });
    ok(await design({ action: "saveDraft", businessId: W, config: { sections: { visible: { gallery: true, entourage: true } } } }));
    ok(await design({ action: "publish", businessId: W }));
    const v = ok(await invite({ action: "view", token })).invitation;
    expect(v.gallery).toEqual(["data:image/jpeg;base64,/9j/4AAQ"]);
    expect(v.entourage).toEqual([{ label: "Principal Sponsors", names: ["Sanrah"] }]);
    const photo = ok(await owner("setup", { action: "get" })).gallery[0].id;
    ok(await owner("setup", { action: "galleryRemove", photoId: photo }));
    expect(ok(await invite({ action: "view", token })).invitation.gallery).toEqual([]);
  });

  it("Master Backup keeps the invitation design (status, template, version, config)", async () => {
    await wedding();
    await assignPlan({ ...world, businessId: W, planId: "bridal-plus", actor: "ops", reason: "upgrade" });
    ok(await design({ action: "saveDraft", businessId: W, config: { templateId: "garden" } }));
    ok(await design({ action: "publish", businessId: W }));
    const res = await createBackupHandler(deps())({ ...request({ uid: u.camille, businessId: W, method: "POST" }), body: "{}" });
    const rows = readXlsx(Buffer.from(res.body, "base64"), { sheet: "Invitation Design" }).rows;
    const map = Object.fromEntries(rows.slice(1).map((r) => [r[0], r[1]]));
    expect(map).toMatchObject({ "Invitation level": "custom", "Guests see": "custom", "Published version": "1", "Published template": "garden" });
  });
});
