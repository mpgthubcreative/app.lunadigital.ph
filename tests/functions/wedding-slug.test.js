// Owner-pilot Bridal invitation refinements: the friendly wedding link
// (/w/{weddingSlug}/invite/{token}: unique slug, made from the couple's
// names when blank; cosmetic only, the token still decides) and partial
// attendance (2 reserved → 1 or 2 attending: totals, categories, seating
// and history all use the confirmed number).

import { describe, it, expect, beforeEach } from "vitest";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createInviteHandler } from "../../netlify/functions/invite.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request, roomForTeam } from "../helpers/tenants.js";
import { slugify, suggestWeddingSlug, isWeddingSlug, invitePath, validateWeddingSetup, rsvpSummary, rsvpByCategory, seatingPlan, TOTALS_DOC_ID, SEATING_DOC_ID } from "../../shared/wedding.js";
import { guestRsvpLabel } from "../../netlify/functions/_lib/invitations.js";

const NOW = new Date("2026-10-16T04:00:00Z");
const W = "biz-wed";
const W2 = "biz-wed-2";
let world;
let u;

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Reyes-Prado Wedding", planId: "bridal-plus", workspaceTemplateId: "bridal-expense", businessId: W }); await roomForTeam(world, W);
  await createBusiness({ ...world, name: "Cruz Wedding", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W2 }); await roomForTeam(world, W2);
  u = {};
  const add = async (key, businessId, role) => {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@slug.test`, name: key });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  };
  await add("carlo", W, "owner");
  await add("other", W2, "owner");
});

const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const H = { guests: createGuestsHandler, setup: createWeddingSetupHandler };
async function api(kind, uid, body, businessId = W) {
  const res = await H[kind](deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function guest(body) {
  const res = await createInviteHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const docAt = (p, businessId = W) => world.db.docs.get(`businesses/${businessId}/${p}`);
const SETUP = { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", rsvpDeadline: "2027-01-15", rsvpEnabled: true };
const save = (setup, uid = u.carlo, businessId = W) => api("setup", uid, { action: "save", setup }, businessId);
async function party(name = "Maria Santos", partySize = 2, category = "family") {
  const g = ok(await api("guests", u.carlo, { action: "create", guest: { name, category, side: "bride", partySize } }), 201).guestId;
  const link = ok(await api("guests", u.carlo, { action: "inviteLink", guestId: g }));
  return { g, path: link.path, token: link.path.split("/").pop() };
}

describe("friendly wedding link", () => {
  it("slugs: lowercase, URL-safe, hyphens; suggested from the couple names", () => {
    expect(slugify("Carlo & Yanie")).toBe("carlo-and-yanie");
    expect(suggestWeddingSlug("Carlo & Yanie")).toBe("carlo-and-yanie-wedding");
    expect(suggestWeddingSlug("  José  +  Añá ")).toBe("jose-and-ana-wedding");
    expect(suggestWeddingSlug("")).toBe("");
    expect([isWeddingSlug("carloyanieforever"), isWeddingSlug("carlo-and-yanie-wedding"), isWeddingSlug("Carlo"), isWeddingSlug("a--b"), isWeddingSlug("-ab"), isWeddingSlug("ab"), isWeddingSlug("x".repeat(61))]).toEqual([true, true, false, false, false, false, false]);
    expect(validateWeddingSetup({ weddingSlug: " CarloYanieForever " })).toEqual({ weddingSlug: "carloyanieforever" });
    expect(() => validateWeddingSetup({ weddingSlug: "carlo/../yanie" })).toThrow(/lowercase letters, numbers and hyphens/);
    expect(invitePath("carloyanieforever", "T".repeat(32))).toBe(`/w/carloyanieforever/invite/${"T".repeat(32)}`);
    expect(invitePath(null, "T".repeat(32))).toBe(`/invite/${"T".repeat(32)}`);
  });

  it("blank → made from the couple names; links use /w/{slug}/invite/{token}; the slug is reserved for this wedding (server-only registry)", async () => {
    expect(ok(await save(SETUP)).setup.weddingSlug).toBe("carlo-and-yanie-wedding");
    expect(world.db.docs.get("weddingSlugs/carlo-and-yanie-wedding")).toMatchObject({ businessId: W });
    const { path, token } = await party();
    expect(path).toBe(`/w/carlo-and-yanie-wedding/invite/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // Saving again keeps the same slug (no -2 for itself).
    expect(ok(await save({ ...SETUP, dressCode: "Formal" })).setup.weddingSlug).toBe("carlo-and-yanie-wedding");
  });

  it("a custom hashtag; another wedding can't take it; the same names elsewhere get -2", async () => {
    expect(ok(await save({ ...SETUP, weddingSlug: "carloyanieforever" })).setup.weddingSlug).toBe("carloyanieforever");
    const taken = await save({ ...SETUP, weddingSlug: "carloyanieforever" }, u.other, W2);
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe("slug-taken");
    expect(world.db.docs.get("weddingSlugs/carloyanieforever").businessId).toBe(W);
    // W2 (same couple names) gets the plain suggestion; W can't then take it.
    ok(await save({ ...SETUP, weddingSlug: null }, u.other, W2));
    expect(docAt("weddingSetup/current", W2).weddingSlug).toBe("carlo-and-yanie-wedding");
    expect((await save({ ...SETUP, weddingSlug: "carlo-and-yanie-wedding" })).body.error).toBe("slug-taken");
    expect(docAt("weddingSetup/current").weddingSlug).toBe("carloyanieforever"); // refused: unchanged
    // Blank in W now: the suggestion is taken, so -2.
    expect(ok(await save({ ...SETUP, weddingSlug: null })).setup.weddingSlug).toBe("carlo-and-yanie-wedding-2");
    expect(world.db.docs.has("weddingSlugs/carloyanieforever")).toBe(false);
  });

  it("changing the slug: old links keep working through the token and point to the new address; the old slug is freed", async () => {
    ok(await save({ ...SETUP, weddingSlug: "carloyanieforever" }));
    const { token, g } = await party();
    ok(await save({ ...SETUP, weddingSlug: "carlo-yanie-2027" }));
    expect(world.db.docs.has("weddingSlugs/carloyanieforever")).toBe(false);
    expect(world.db.docs.get("weddingSlugs/carlo-yanie-2027").businessId).toBe(W);
    const v = ok(await guest({ action: "view", token })).invitation;
    expect(v.path).toBe(`/w/carlo-yanie-2027/invite/${token}`);
    expect(v.guest.name).toBe("Maria Santos");
    expect(ok(await api("guests", u.carlo, { action: "inviteLink", guestId: g })).path).toBe(`/w/carlo-yanie-2027/invite/${token}`);
    expect(JSON.stringify(v)).not.toContain(W);
  });

  it("a valid slug never opens anything without the right token; a slug isn't accepted as a credential", async () => {
    ok(await save({ ...SETUP, weddingSlug: "carloyanieforever" }));
    const { token } = await party();
    for (const t of ["", "carloyanieforever", "A".repeat(32), token.slice(0, 31) + (token.at(-1) === "A" ? "B" : "A")]) {
      const r = await guest({ action: "view", token: t });
      expect(r.status, t).toBe(404);
      expect(r.body.message).toMatch(/isn't valid/);
    }
    expect((await guest({ action: "view", token, slug: "carloyanieforever" })).status).toBe(400); // only the token is taken
    // The other wedding's guest link opens THEIR wedding, whatever slug is in the address.
    ok(await save({ ...SETUP, coupleNames: "Ana & Ben", weddingSlug: null }, u.other, W2));
    const g2 = ok(await api("guests", u.other, { action: "create", guest: { name: "Cruz Family", category: "family", side: "bride", partySize: 3 } }, W2), 201).guestId;
    const t2 = ok(await api("guests", u.other, { action: "inviteLink", guestId: g2 }, W2)).path.split("/").pop();
    const v2 = ok(await guest({ action: "view", token: t2 })).invitation;
    expect(v2.wedding.coupleNames).toBe("Ana & Ben");
    expect(v2.path).toBe(`/w/ana-and-ben-wedding/invite/${t2}`);
  });

  it("a wedding set up before slugs gets one on its next link; old /invite/{token} links keep working", async () => {
    world.db.docs.set(`businesses/${W}/weddingSetup/current`, { ...SETUP, schemaVersion: 1 });
    const { path, token } = await party();
    expect(path).toBe(`/w/carlo-and-yanie-wedding/invite/${token}`);
    expect(ok(await guest({ action: "view", token })).invitation.path).toBe(path);
  });
});

describe("reserved seats vs actually attending", () => {
  const totals = () => docAt(`guestTotals/${TOTALS_DOC_ID}`);
  const family = () => rsvpByCategory(totals()).find((r) => r.id === "family");

  it("2 reserved → 1 attending: totals and the category grow by 1, not 2; history 'Attending · 1 of 2'", async () => {
    ok(await save(SETUP));
    const { g, token } = await party();
    await party("Reyes Family", 4);
    const before = { all: rsvpSummary(totals()).attendingSeats, fam: family().attendingSeats };
    ok(await guest({ action: "respond", token, rsvp: { status: "attending", confirmed: 1 } }));
    expect(docAt(`guests/${g}`)).toMatchObject({ rsvp: "attending", confirmed: 1, partySize: 2, rsvpSource: "guest" });
    expect(rsvpSummary(totals()).attendingSeats - before.all).toBe(1);
    expect(family().attendingSeats - before.fam).toBe(1);
    expect(family().invitedSeats).toBe(6); // invited stays 2 + 4
    expect(docAt(`guests/${g}`).history.at(-1)).toMatchObject({ label: "Guest responded: Attending · 1 of 2", source: "guest", from: { rsvp: "awaiting", confirmed: 0 }, to: { status: "attending", confirmed: 1 } });
    // More than reserved: refused.
    expect((await guest({ action: "respond", token, rsvp: { status: "attending", confirmed: 3 } })).status).toBe(400);
  });

  it("2 reserved → 2 attending; then a change 2 of 2 → 1 of 2 keeps both lines with source and time", async () => {
    ok(await save(SETUP));
    const { g, token } = await party();
    ok(await guest({ action: "respond", token, rsvp: { status: "attending", confirmed: 2 } }));
    expect(rsvpSummary(totals()).attendingSeats).toBe(2);
    ok(await guest({ action: "respond", token, rsvp: { status: "attending", confirmed: 1 } }));
    expect(rsvpSummary(totals()).attendingSeats).toBe(1);
    const h = docAt(`guests/${g}`).history.filter((x) => x.source === "guest");
    expect(h.map((x) => x.label)).toEqual(["Guest responded: Attending · 2 of 2", "Guest changed RSVP: 2 of 2 → 1 of 2"]);
    expect(h.every((x) => x.at instanceof Date)).toBe(true);
    expect(guestRsvpLabel({ rsvp: "attending", confirmed: 1 }, { status: "attending", confirmed: 2 }, 2)).toBe("Guest changed RSVP: 1 of 2 → 2 of 2");
    expect(guestRsvpLabel({ rsvp: "awaiting", confirmed: 0 }, { status: "declined", confirmed: 0 }, 2)).toBe("Guest responded: Declined");
  });

  it("Seating uses confirmed attendees: a 2-seat party with 1 coming takes 1 seat; 1 → 2 updates the table and flags it when full", async () => {
    ok(await save(SETUP));
    const { g, token } = await party();
    const t = ok(await api("guests", u.carlo, { action: "createTable", table: { name: "Table 1", capacity: 2 } }), 201).tableId;
    const filler = ok(await api("guests", u.carlo, { action: "create", guest: { name: "Tan", category: "friends", side: "groom", partySize: 1 } }), 201).guestId;
    ok(await api("guests", u.carlo, { action: "setRsvp", guestId: filler, rsvp: { status: "attending", confirmed: 1 } }));
    ok(await api("guests", u.carlo, { action: "seat", guestId: filler, tableId: t }));
    ok(await guest({ action: "respond", token, rsvp: { status: "attending", confirmed: 1 } }));
    ok(await api("guests", u.carlo, { action: "seat", guestId: g, tableId: t }));
    const plan = () => seatingPlan([g, filler].map((id) => ({ id, ...docAt(`guests/${id}`) })), docAt(`guestTotals/${SEATING_DOC_ID}`));
    expect(plan().tables[0]).toMatchObject({ capacity: 2, used: 2 });
    expect(plan().attendingSeats).toBe(2);
    ok(await guest({ action: "respond", token, rsvp: { status: "attending", confirmed: 2 } }));
    expect(docAt(`guests/${g}`).tableId).toBe(t); // still seated
    expect(plan().tables[0].used).toBe(3); // 3 of 2 → shown "over by 1" on Seating
  });
});

describe("Sample Budget lines and the cover photo (server)", () => {
  it("a Planned line with no amount: createCategory { planned: true } stores it without touching the budget total; planned must be true/false; removing it from the plan is logged", async () => {
    const { createBudgetHandler } = await import("../../netlify/functions/budget.js");
    const budget = async (body) => {
      const res = await createBudgetHandler(deps())({ ...request({ uid: u.carlo, businessId: W, method: "POST" }), body: JSON.stringify(body) });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    };
    const id = ok(await budget({ action: "createCategory", category: { name: "Lights & sounds", budget: null, planned: true } }), 201).categoryId;
    expect(docAt(`expenseCategories/${id}`)).toMatchObject({ name: "Lights & sounds", budget: null, planned: true, status: "active" });
    expect(docAt(`expenseCategories/${id}`).history.at(-1).label).toBe("Added category Lights & sounds · on the plan");
    expect(docAt("budgets/current")?.total ?? null).toBe(null);
    expect((await budget({ action: "createCategory", category: { name: "Catering", planned: "yes" } })).status).toBe(400);
    ok(await budget({ action: "updateCategory", categoryId: id, changes: { budget: null, planned: false } }));
    expect(docAt(`expenseCategories/${id}`).planned).toBe(false);
    expect(docAt(`expenseCategories/${id}`).history.at(-1).label).toBe("Removed from the plan");
  });

  it("Wedding Setup get returns the current cover photo so the Owner sees it", async () => {
    const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ";
    // Checked by its bytes, not the label: "ABC" called a JPEG is refused.
    expect((await api("setup", u.carlo, { action: "hero", dataUrl: "data:image/jpeg;base64,QUJD" })).status).toBe(400);
    expect((await api("setup", u.carlo, { action: "galleryAdd", dataUrl: "data:image/png;base64,/9j/4AAQSkZJRgABAQ" })).status).toBe(400);
    ok(await api("setup", u.carlo, { action: "hero", dataUrl: PHOTO }));
    expect(ok(await api("setup", u.carlo, { action: "get" }))).toMatchObject({ hasHero: true, hero: PHOTO });
    ok(await api("setup", u.carlo, { action: "hero", dataUrl: null }));
    expect(ok(await api("setup", u.carlo, { action: "get" }))).toMatchObject({ hasHero: false, hero: null });
  });
});
