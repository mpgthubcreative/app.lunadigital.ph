// Generic Wedding Setup (2026-10-24): ONE wedding profile (information) for
// every invitation template (presentation). New fields are optional and
// additive: an older wedding reads and shows exactly as before; switching
// templates never loses data; a template's photo slots and wording are
// kept per wedding; the RSVP can ask a meal and a dietary note. Tenant
// isolation as everywhere: one wedding's profile / photos never reach
// another's links.

import { describe, it, expect, beforeEach } from "vitest";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createInviteHandler } from "../../netlify/functions/invite.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { GUEST_COLUMNS } from "../../netlify/functions/_lib/exports/wedding.js";
import { buildWorld, request, roomForTeam } from "../helpers/tenants.js";
import { validateWeddingSetup, coupleDisplayName, coupleNameParts, setupMissing, SETUP_FIELDS } from "../../shared/wedding.js";
import { INVITATION_CONTENT_FIELDS, invitationData, getTemplateEntry } from "../../shared/invitation-design.js";
import { RESET_PLAN } from "../../shared/reset.js";

const NOW = new Date("2026-10-24T03:00:00Z");
const W = "wed-profile";
const W2 = "wed-other";
let world;
const u = {};
beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Camille & Carlo", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W });
  await roomForTeam(world, W);
  await createBusiness({ ...world, name: "Other Wedding", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W2 });
  await roomForTeam(world, W2);
  for (const [key, businessId] of [["owner", W], ["other", W2]]) {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@profile.test`, name: key });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key, roleTemplate: "owner", isAccountOwner: true });
    u[key] = x.uid;
  }
});
const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const H = { guests: createGuestsHandler, setup: createWeddingSetupHandler };
const api = async (kind, body, uid = u.owner, businessId = W) => {
  const res = await H[kind](deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const invite = async (body) => {
  const res = await createInviteHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const docAt = (p, businessId = W) => world.db.docs.get(`businesses/${businessId}/${p}`);
const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const linkFor = async (name, extra = {}) => {
  const g = ok(await api("guests", { action: "create", guest: { name, category: "family", side: "bride", partySize: 2, ...extra } }), 201).guestId;
  const { path } = ok(await api("guests", { action: "inviteLink", guestId: g }));
  return { guestId: g, token: path.split("/").pop() };
};

describe("the shared profile fields", () => {
  it("validates the new optional fields: paragraphs kept, lists trimmed, schedule sorted, colours checked, wording per design", () => {
    const out = validateWeddingSetup({
      partner1Name: " Camille ",
      partner2Name: "Carlo",
      story: "We met in 2019.\r\n\r\n\r\n  Then   Tagaytay.",
      schedule: [{ time: "18:00", title: "Dinner" }, { time: "15:00", title: "Ceremony" }, { time: "", title: "  " }],
      palette: [{ name: "Sage", hex: "#8FA382" }],
      attireNotes: ["No white", ""],
      mealOptions: ["Beef", "Fish"],
      sameVenue: true,
      askDietary: true,
      templateOptions: { gold: { wording: { intro: "With joy", tagline: "" }, accent: "rose" }, rustic: { accent: null } },
    });
    expect(out).toMatchObject({ partner1Name: "Camille", story: "We met in 2019.\n\nThen Tagaytay.", schedule: [{ time: "15:00", title: "Ceremony" }, { time: "18:00", title: "Dinner" }], palette: [{ name: "Sage", hex: "#8fa382" }], attireNotes: ["No white"], mealOptions: ["Beef", "Fish"], sameVenue: true, askDietary: true });
    expect(out.templateOptions).toEqual({ gold: { wording: { intro: "With joy", tagline: null }, accent: "rose" }, rustic: { accent: null } });
    for (const bad of [{ palette: [{ name: "x", hex: "red" }] }, { schedule: [{ time: "25:00", title: "x" }] }, { mealOptions: Array(7).fill("x") }, { templateOptions: { garden: {} } }, { templateOptions: { gold: { wording: { notALine: "x" } } } }, { templateOptions: { gold: { accent: "purple" } } }, { templateOptions: { monochrome: { accent: "gold" } } }, { hashtagz: "x" }]) expect(() => validateWeddingSetup(bad), JSON.stringify(bad)).toThrow();
  });
  it("the names line: typed, else 'Partner 1 & Partner 2'; older weddings split at & / and", () => {
    expect(coupleDisplayName({ partner1Name: "Camille", partner2Name: "Carlo" })).toBe("Camille & Carlo");
    expect(coupleDisplayName({ coupleNames: "Cams & Carl", partner1Name: "Camille" })).toBe("Cams & Carl");
    expect(coupleNameParts({ coupleNames: "Ana and Ben" })).toEqual(["Ana", "Ben"]);
    expect(coupleNameParts({ coupleNames: "Ana" })).toEqual(["Ana"]);
    expect(setupMissing({ partner1Name: "Camille", weddingDate: "2027-02-14" })).toEqual([]);
    expect(setupMissing({})).toEqual(["the couple's names", "the wedding date"]);
  });
  it("the invitation contract carries the new fields (null for an older wedding) and the names line", () => {
    for (const k of ["partner1Name", "city", "schedule", "palette", "gettingThere", "mealOptions", "askDietary", "rsvpContact"]) expect(INVITATION_CONTENT_FIELDS).toContain(k);
    const old = invitationData({ setup: { coupleNames: "Camille & Carlo", weddingDate: "2027-12-12" }, guest: {}, rsvpOpen: true });
    expect(old.wedding).toMatchObject({ coupleNames: "Camille & Carlo", schedule: null, palette: null, city: null });
    expect(old).toMatchObject({ photos: {}, options: null, design: null });
    expect(invitationData({ setup: { partner1Name: "A", partner2Name: "B" }, guest: {}, rsvpOpen: true }).wedding.coupleNames).toBe("A & B");
  });
});

describe("Wedding Setup → guests' invitations", () => {
  it("an older wedding (only the original fields) keeps working: link, the same page, saving one new field changes nothing else", async () => {
    const OLD = { coupleNames: "Camille & Carlo", weddingDate: "2027-12-12", ceremonyVenue: "Example Church", dressCode: "Formal", rsvpEnabled: true, rsvpDeadline: "2027-11-15" };
    // Written as an older wedding had it (no new fields at all).
    world.db.docs.set(`businesses/${W}/weddingSetup/current`, { ...OLD, schemaVersion: 1 });
    const { token } = await linkFor("Maria Santos");
    const inv = ok(await invite({ action: "view", token })).invitation;
    const { rsvpEnabled: _settingNotContent, ...shown } = OLD;
    expect(inv.wedding).toMatchObject(shown);
    expect(inv.design).toBeNull(); // Luna Standard page, as before
    ok(await api("setup", { action: "save", setup: { city: "Taguig" } }));
    expect(docAt("weddingSetup/current")).toMatchObject({ ...OLD, city: "Taguig" });
  });
  it("partners' names only: links can be made, the invitation and the wedding link use 'Camille & Carlo'", async () => {
    ok(await api("setup", { action: "save", setup: { partner1Name: "Camille", partner2Name: "Carlo", weddingDate: "2027-02-14", rsvpEnabled: true } }));
    expect(docAt("weddingSetup/current").weddingSlug).toBe("camille-and-carlo-wedding");
    const { token } = await linkFor("Maria Santos");
    expect(ok(await invite({ action: "view", token })).invitation.wedding.coupleNames).toBe("Camille & Carlo");
  });
  it("a signature design: its photo slots, wording and accent reach the guest; switching designs keeps everything", async () => {
    ok(await api("setup", { action: "save", setup: { partner1Name: "Camille", partner2Name: "Carlo", weddingDate: "2027-02-14", city: "Tagaytay", schedule: [{ time: "15:00", title: "Ceremony" }], templateId: "gold", templateOptions: { gold: { wording: { tagline: "are tying the knot" }, accent: "sage" } } } }));
    ok(await api("setup", { action: "photo", slot: "story1", dataUrl: PHOTO }));
    ok(await api("setup", { action: "photo", slot: "venue", dataUrl: PHOTO }));
    expect(ok(await api("setup", { action: "photo", slot: "cover", dataUrl: PHOTO }), 400));
    expect((await api("setup", { action: "photo", slot: "story2", dataUrl: "data:text/html;base64,PGgxPg==" })).status).toBe(400);
    const got = ok(await api("setup", { action: "get" }));
    expect(Object.keys(got.photos).sort()).toEqual(["story1", "venue"]);
    const { token } = await linkFor("Maria Santos");
    const inv = ok(await invite({ action: "view", token })).invitation;
    expect(inv.design.config).toMatchObject({ templateId: "gold", kind: "signature", variant: "gold" });
    expect(Object.keys(inv.photos).sort()).toEqual(["story1", "venue"]);
    expect(inv.options).toEqual({ wording: { tagline: "are tying the knot" }, accent: "#7d8f69" });
    expect(inv.timezone).toBe("Asia/Manila");
    expect(inv.wedding).toMatchObject({ city: "Tagaytay", schedule: [{ time: "15:00", title: "Ceremony" }] });
    // Switch to Rustic (its own wording), then to Classic: nothing is lost.
    ok(await api("setup", { action: "save", setup: { templateId: "rustic", templateOptions: { ...docAt("weddingSetup/current").templateOptions, rustic: { wording: { intro: "With joy" }, accent: "olive" } } } }));
    ok(await api("setup", { action: "save", setup: { templateId: "classic" } }));
    const s = docAt("weddingSetup/current");
    expect(s.templateOptions.gold).toEqual({ wording: { tagline: "are tying the knot" }, accent: "sage" });
    expect(s.templateOptions.rustic).toEqual({ wording: { intro: "With joy" }, accent: "olive" });
    expect(s).toMatchObject({ city: "Tagaytay", partner1Name: "Camille", schedule: [{ time: "15:00", title: "Ceremony" }] });
    const classic = ok(await invite({ action: "view", token })).invitation;
    expect(classic.design.config).toMatchObject({ templateId: "classic", kind: "card" });
    expect(classic.photos).toEqual({}); // Classic has no photo slots: nothing extra is sent
    expect(docAt("weddingPhotos/story1")).toBeTruthy(); // ...but they're kept
    // Removing a slot photo.
    ok(await api("setup", { action: "photo", slot: "venue", dataUrl: null }));
    expect(docAt("weddingPhotos/venue")).toBeUndefined();
  });
  it("tenant isolation: another wedding's photos / wording never reach these links, and its Owner can't write here", async () => {
    ok(await api("setup", { action: "save", setup: { coupleNames: "Camille & Carlo", weddingDate: "2027-02-14", templateId: "gold" } }));
    ok(await api("setup", { action: "save", setup: { coupleNames: "Other", weddingDate: "2027-03-01", templateId: "gold", templateOptions: { gold: { wording: { intro: "OTHER" } } } } }, u.other, W2));
    ok(await api("setup", { action: "photo", slot: "story1", dataUrl: PHOTO }, u.other, W2));
    expect(docAt("weddingPhotos/story1", W2)).toBeTruthy();
    expect(docAt("weddingPhotos/story1")).toBeUndefined();
    const { token } = await linkFor("Maria Santos");
    const inv = ok(await invite({ action: "view", token })).invitation;
    expect(inv.photos).toEqual({});
    expect(inv.options).toBeNull();
    expect(JSON.stringify(inv)).not.toContain("OTHER");
    // The other Owner, pointed at this wedding: refused.
    expect((await api("setup", { action: "photo", slot: "story2", dataUrl: PHOTO }, u.other, W)).status).toBeGreaterThanOrEqual(403);
    expect(docAt("weddingPhotos/story2")).toBeUndefined();
  });
});

describe("RSVP: meal choice and dietary note (only when Wedding Setup asks)", () => {
  const SETUP = { coupleNames: "Camille & Carlo", weddingDate: "2027-02-14", rsvpEnabled: true, rsvpDeadline: "2027-01-15" };
  it("not asked: answers work exactly as before (meal / note ignored, nothing stored)", async () => {
    ok(await api("setup", { action: "save", setup: SETUP }));
    const { guestId, token } = await linkFor("Maria Santos");
    ok(await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 2, meal: "Beef", note: "x" } }));
    const g = docAt(`guests/${guestId}`);
    expect(g).toMatchObject({ rsvp: "attending", confirmed: 2 });
    expect(g.rsvpMeal).toBeUndefined();
    expect(g.rsvpNote).toBeUndefined();
  });
  it("asked: stored on the guest, shown back to that party, changeable; a meal not offered is refused; declining clears them", async () => {
    ok(await api("setup", { action: "save", setup: { ...SETUP, mealOptions: ["Beef", "Fish", "Vegetarian"], askDietary: true } }));
    const { guestId, token } = await linkFor("Maria Santos");
    expect((await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 1, meal: "Pork" } })).status).toBe(400);
    expect((await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 1, note: "x".repeat(301) } })).status).toBe(400);
    expect(ok(await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 2, meal: "Fish", note: "  No   shellfish " } }))).toMatchObject({ rsvp: "attending", rsvpMeal: "Fish", rsvpNote: "No shellfish" });
    expect(docAt(`guests/${guestId}`)).toMatchObject({ rsvp: "attending", confirmed: 2, rsvpMeal: "Fish", rsvpNote: "No shellfish", rsvpSource: "guest" });
    expect(ok(await invite({ action: "view", token })).invitation.guest).toMatchObject({ meal: "Fish", note: "No shellfish" });
    // Same answer, another meal: saved and in the history.
    ok(await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 2, meal: "Beef", note: "No shellfish" } }));
    const g = docAt(`guests/${guestId}`);
    expect(g.rsvpMeal).toBe("Beef");
    expect(g.history.at(-1).label).toBe("Guest updated their meal / dietary note");
    ok(await invite({ action: "respond", token, rsvp: { status: "declined" } }));
    expect(docAt(`guests/${guestId}`)).toMatchObject({ rsvp: "declined", rsvpMeal: null, rsvpNote: null });
  });
  it("the Download Excel guest sheet has Meal and Dietary note", () => {
    const cols = GUEST_COLUMNS.map((c) => c.header);
    expect(cols).toEqual(expect.arrayContaining(["Meal", "Dietary note"]));
    expect(GUEST_COLUMNS.find((c) => c.header === "Meal").value({ rsvpMeal: "Fish" })).toBe("Fish");
  });
});

describe("data reset and the registry", () => {
  it("Reset removes the invitation photos with the gallery and keeps Wedding Setup", () => {
    const plan = RESET_PLAN["bridal-expense"];
    expect(plan.removes).toEqual(expect.arrayContaining(["weddingGallery", "weddingPhotos"]));
    expect(plan.removes).not.toContain("weddingSetup");
  });
  it("every Standard design asks only for fields Wedding Setup has", () => {
    for (const id of ["gold", "monochrome", "rustic", "classic"]) for (const k of getTemplateEntry(id).uses) expect(SETUP_FIELDS, `${id}: ${k}`).toContain(k);
  });
});
