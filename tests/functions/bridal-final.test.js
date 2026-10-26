// Bridal final consolidated pass (2026-10-25): one Bridal product (Luna
// Bridal Custom is legacy), the family list per side, Reset invitation (its
// scope, and never guests / RSVPs / the link), and companion names given at
// RSVP on the party's one link.

import { describe, it, expect, beforeEach } from "vitest";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createInviteHandler } from "../../netlify/functions/invite.js";
import { createSubscriptionHandler } from "../../netlify/functions/subscription.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { INVITATION_RESET_FIELDS } from "../../netlify/functions/_lib/invitations.js";
import { buildWorld, request, roomForTeam } from "../helpers/tenants.js";
import { seatsOf } from "../../shared/wedding-seating.js";
import { getTemplateEntry } from "../../shared/invitation-design.js";

const NOW = new Date("2026-10-25T03:00:00Z");
const W = "wed-final";
const X = "wed-other";
const T = "wed-trial-final";
let world;
const u = {};
beforeEach(async () => {
  world = await buildWorld();
  for (const [businessId, trial] of [[W, false], [X, false], [T, true]]) {
    await createBusiness({ ...world, name: businessId, planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId, ...(trial ? { trial: true, clock: NOW } : {}) });
    await roomForTeam(world, businessId);
    const x = await ensureAuthUser({ auth: world.auth, email: `${businessId}@final.test`, name: businessId });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: businessId, roleTemplate: "owner", isAccountOwner: true });
    u[businessId] = x.uid;
  }
});
const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const call = async (handler, body, businessId = W) => {
  const res = await handler(deps())({ ...request({ uid: u[businessId], businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const setup = (body, b) => call(createWeddingSetupHandler, body, b);
const guests = (body, b) => call(createGuestsHandler, body, b);
const sub = (body, b) => call(createSubscriptionHandler, body, b);
const invite = async (body) => {
  const res = await createInviteHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const doc = (path) => world.db.docs.get(`businesses/${W}/${path}`);
const live = async () => ok(await setup({ action: "save", setup: { partner1Name: "Camille", partner2Name: "Carlo", coupleNames: "Camille & Carlo", weddingDate: "2027-05-15", rsvpEnabled: true, templateId: "gold", published: true } }));
const linkFor = async (name, partySize) => {
  const g = ok(await guests({ action: "create", guest: { name, side: "both", partySize } }), 201).guestId;
  return { g, token: ok(await guests({ action: "inviteLink", guestId: g })).path.split("/").pop() };
};

describe("one Bridal product: Luna Bridal Custom is legacy", () => {
  it("a trial wedding can continue only with Luna Bridal; Custom is refused, and isn't among its options", async () => {
    const res = await createSubscriptionHandler(deps())(request({ uid: u[T], businessId: T, method: "GET" }));
    expect(res.statusCode, res.body).toBe(200);
    const s = JSON.parse(res.body);
    expect((s.subscription?.options ?? s.options).map((o) => o.planId)).toEqual(["bridal-basic"]);
    const r = await sub({ action: "choose", planId: "bridal-plus", termMonths: 12 }, T);
    expect(r.status).toBe(400);
    expect(world.db.docs.get(`businesses/${T}`).subscription.planId).toBe("bridal-basic");
    expect(ok(await sub({ action: "choose", planId: "bridal-basic", termMonths: 3 }, T)).invoice.amountDue).toBe(49900);
  });
});

describe("Family: several people per side", () => {
  it("relation (or none / Other with its own word) + name, in order; refused when invalid; the older one line still shows", async () => {
    await live();
    ok(await setup({ action: "save", setup: { partner2Family: [{ relation: "father", name: "Ramon A. Prado" }, { relation: "mother", name: "Maria Prado" }, { relation: "other", label: "Ninang", name: "Tita Linda" }, { relation: "", name: "John Prado" }, { relation: "other", label: "", name: "Lola Cora" }] } }));
    expect(doc("weddingSetup/current").partner2Family).toEqual([{ relation: "father", name: "Ramon A. Prado" }, { relation: "mother", name: "Maria Prado" }, { relation: "other", label: "Ninang", name: "Tita Linda" }, { relation: "", name: "John Prado" }, { relation: "", name: "Lola Cora" }]);
    // Reorder = save the list in its new order.
    ok(await setup({ action: "save", setup: { partner2Family: [{ relation: "mother", name: "Maria Prado" }, { relation: "father", name: "Ramon A. Prado" }] } }));
    expect(doc("weddingSetup/current").partner2Family.map((m) => m.name)).toEqual(["Maria Prado", "Ramon A. Prado"]);
    expect((await setup({ action: "save", setup: { partner1Family: [{ relation: "boss", name: "X" }] } })).status).toBe(400);
    expect((await setup({ action: "save", setup: { partner1Family: [{ relation: "father", name: "X", id: "1" }] } })).status).toBe(400);
    expect((await setup({ action: "save", setup: { partner1Family: Array.from({ length: 13 }, (_, i) => ({ relation: "", name: `P${i}` })) } })).status).toBe(400);
    // An older wedding's one line stays and still reaches the guest.
    ok(await setup({ action: "save", setup: { partner1Parents: "Mr. & Mrs. Reyes" } }));
    const { token } = await linkFor("Maria Santos", 1);
    const w = ok(await invite({ action: "view", token })).invitation.wedding;
    expect(w).toMatchObject({ partner1Parents: "Mr. & Mrs. Reyes", partner2Family: [{ relation: "mother", name: "Maria Prado" }, { relation: "father", name: "Ramon A. Prado" }] });
    // The signature designs edit it from the Family section.
    expect(getTemplateEntry("gold").fieldMappings.family.fields).toEqual(["partner1Family", "partner2Family", "partner1Parents", "partner2Parents"]);
  });
});

describe("Reset invitation (⋯ → Reset invitation)", () => {
  it("clears the invitation's content, wording, accents and photos; keeps names, date, venues, RSVP settings, link, publish state; never touches guests, RSVPs or another wedding", async () => {
    await live();
    ok(await setup({ action: "save", setup: { ceremonyVenue: "St. Michael Parish", ceremonyTime: "15:00", rsvpDeadline: "2027-04-01", mealOptions: ["Beef", "Fish"], story: "We met in Manila.", welcomeMessage: "Welcome!", partner1Family: [{ relation: "father", name: "Jose" }], dressCode: "Formal", palette: [{ name: "Sage", hex: "#b9c8ae" }], faq: [{ q: "Kids?", a: "Adults only." }], footerNote: "See you!", templateOptions: { gold: { wording: { intro: "Together" }, accent: getTemplateEntry("gold").accents[0]?.id ?? null } } } }));
    const img = "data:image/jpeg;base64,/9j/AAAA";
    ok(await setup({ action: "hero", dataUrl: img }));
    ok(await setup({ action: "photo", slot: "story1", dataUrl: img }));
    ok(await setup({ action: "galleryAdd", dataUrl: img }));
    const { g, token } = await linkFor("Carlo Prado", 2);
    ok(await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 2, meal: "Beef" } }));
    world.db.docs.set(`businesses/${X}/weddingSetup/current`, { coupleNames: "Other & Wedding", story: "Theirs." });
    const guestBefore = structuredClone(doc(`guests/${g}`));
    const slug = doc("weddingSetup/current").weddingSlug;

    const r = ok(await setup({ action: "resetInvitation" }));
    const s = doc("weddingSetup/current");
    for (const k of INVITATION_RESET_FIELDS) expect(s, k).not.toHaveProperty(k);
    expect(s).toMatchObject({ coupleNames: "Camille & Carlo", weddingDate: "2027-05-15", ceremonyVenue: "St. Michael Parish", ceremonyTime: "15:00", rsvpEnabled: true, rsvpDeadline: "2027-04-01", mealOptions: ["Beef", "Fish"], templateId: "gold", published: true, weddingSlug: slug });
    expect(r.setup).toMatchObject({ coupleNames: "Camille & Carlo", weddingSlug: slug, published: true });
    for (const k of INVITATION_RESET_FIELDS) expect(r.setup, k).not.toHaveProperty(k);
    expect(doc("weddingSetup/hero")).toBeUndefined();
    expect(doc("weddingPhotos/story1")).toBeUndefined();
    expect([...world.db.docs.keys()].some((k) => k.startsWith(`businesses/${W}/weddingGallery/`))).toBe(false);
    // Guests, RSVP answers and the guest's link are untouched.
    expect(doc(`guests/${g}`)).toEqual(guestBefore);
    const v = ok(await invite({ action: "view", token })).invitation;
    expect(v.guest).toMatchObject({ rsvp: "attending", confirmed: 2, meal: "Beef" });
    expect(v.wedding).toMatchObject({ coupleNames: "Camille & Carlo", story: null, partner1Family: null });
    // Another wedding is never touched.
    expect(world.db.docs.get(`businesses/${X}/weddingSetup/current`)).toEqual({ coupleNames: "Other & Wedding", story: "Theirs." });
  });
});

describe("+1 / +2: one link per party; companion names at RSVP", () => {
  it("the guest names the unnamed seats when accepting; each keeps their table; at most the open seats; never a second link", async () => {
    await live();
    const { g, token } = await linkFor("Ramona Prado", 3); // Ramona + 2
    expect(ok(await invite({ action: "view", token })).invitation.guest.party).toEqual({ named: [], open: 2 });
    // Accept for 3 without names (names are optional), then the couple seats person 2.
    ok(await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 3 } }));
    const t = ok(await guests({ action: "createTable", table: { name: "Table 1", capacity: 8 } }), 201).tableId;
    ok(await guests({ action: "seatPerson", guestId: g, seatKey: "u1", tableId: t }));
    // Later the guest adds a name: it becomes a named member with that seat.
    ok(await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 3, companions: ["Jun Prado", ""] } }));
    const after = doc(`guests/${g}`);
    const jun = after.members.find((m) => m.name === "Jun Prado");
    expect(jun).toBeTruthy();
    expect(seatsOf(after)[jun.id]).toBe(t);
    expect(after.history.at(-1).label).toBe("Guest named their party: Jun Prado");
    expect(ok(await invite({ action: "view", token })).invitation.guest.party).toEqual({ named: ["Jun Prado"], open: 1 });
    // Too many names, or a name already in the party: refused, nothing changes.
    expect((await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 3, companions: ["A", "B"] } })).status).toBe(400);
    expect((await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 3, companions: ["ramona prado"] } })).status).toBe(400);
    expect(doc(`guests/${g}`).members).toHaveLength(1);
    // A +1 with a new answer and a name at once.
    const solo = await linkFor("Carlo Prado", 2);
    ok(await invite({ action: "respond", token: solo.token, rsvp: { status: "attending", confirmed: 2, companions: ["Yanie"] } }));
    expect(doc(`guests/${solo.g}`)).toMatchObject({ rsvp: "attending", confirmed: 2, members: [{ name: "Yanie" }] });
    // Declining never names anyone.
    const decl = await linkFor("Anna Santos", 2);
    ok(await invite({ action: "respond", token: decl.token, rsvp: { status: "declined", companions: ["Ben"] } }));
    expect(doc(`guests/${decl.g}`).members ?? []).toEqual([]);
    // One private link per party: three parties, three links.
    expect([...world.db.docs.keys()].filter((k) => k.startsWith("invitations/")).length).toBe(3);
  });
});

// Custom wedding address (2026-10-26): the address only locates the wedding;
// the guest's private token still decides, and a token from another wedding
// is refused on this address (one generic answer, nothing recorded).
describe("custom wedding address: the token is checked against the address", () => {
  it("own address: works; another wedding's address or an unknown one: the same 'not valid' answer; RSVP refused there", async () => {
    await live();
    const { g, token } = await linkFor("Tita Nena", 1);
    world.db.docs.set("publicLinks/camillecarlo", { businessId: W, kind: "current", current: "camillecarlo", setup: "active" });
    world.db.docs.set("publicLinks/otherwedding", { businessId: X, kind: "current", current: "otherwedding", setup: "active" });
    expect(ok(await invite({ action: "view", token, host: "camillecarlo" })).invitation.guest.name).toBe("Tita Nena");
    expect(ok(await invite({ action: "view", token })).invitation.guest.name).toBe("Tita Nena"); // the app address: unchanged
    const foreign = await invite({ action: "view", token, host: "otherwedding" });
    const unknown = await invite({ action: "view", token, host: "nobody" });
    expect(foreign.status).toBe(404);
    expect(unknown.body).toEqual(foreign.body);
    expect((await invite({ action: "respond", token, host: "otherwedding", rsvp: { status: "attending", confirmed: 1 } })).status).toBe(404);
    expect(doc(`guests/${g}`).rsvp).not.toBe("attending");
    ok(await invite({ action: "respond", token, host: "camillecarlo", rsvp: { status: "attending", confirmed: 1 } }));
    expect(doc(`guests/${g}`).rsvp).toBe("attending");
  });
  it("Wedding Setup's Check: the name is free for this wedding, or taken by another", async () => {
    await live();
    const mine = doc("weddingSetup/current").weddingSlug;
    expect(ok(await setup({ action: "checkSlug", slug: mine })).available).toBe(true);
    world.db.docs.set("weddingSlugs/carlo-yanie", { businessId: X });
    expect(ok(await setup({ action: "checkSlug", slug: "carlo-yanie" })).available).toBe(false);
    expect(ok(await setup({ action: "checkSlug", slug: "free-name-here" })).available).toBe(true);
    expect((await setup({ action: "checkSlug", slug: "Bad Name!" })).status).toBe(400);
  });
});
