// Free trial RSVP (2026-10-28: 50 invited people, was 20): a trial wedding
// sends real RSVP links to at most TRIAL_RSVP_GUESTS invited people. One
// guest record = one party, counted as its party size, once (copy / resend /
// replace count nothing more). The guest list may be larger; the rest wait.
// The server enforces it (no browser trust), the first 50 keep working, and
// paying lifts the limit with the same links. Also here: RSVP open / closed
// and why (Shane's "RSVPs are closed": RSVP switched off), the deadline in
// the wedding's timezone, the neutral page of an ended trial, and the
// trial's Luna-made wedding link (choosing one is paid).

import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createInviteHandler } from "../../netlify/functions/invite.js";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { createBusiness, addMember, ensureAuthUser, setOperator } from "../../netlify/functions/_lib/provisioning.js";
import { TRIAL_RSVP_GUESTS, TRIAL_RSVP_LIMIT_MESSAGE, rsvpState, rsvpSummary } from "../../shared/wedding.js";
import { SLUG_PAID_MESSAGE } from "../../netlify/functions/_lib/invitations.js";

const L = TRIAL_RSVP_GUESTS;

const NOW = new Date();
const W = "wed-rsvp";
let world;
const u = {};

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Carlo & Yanie", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W, trial: true, clock: NOW });
  const o = await ensureAuthUser({ auth: world.auth, email: "camille@rsvp.test", name: "Camille" });
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
const addGuest = async (name, partySize = 1) => ok(await guests({ action: "create", guest: { name, side: "bride", partySize } }), 201).guestId;
const tokenOf = (r) => r.path.split("/").pop();
const usage = async () => ok(await guests({ action: "trialRsvp" })).trialRsvp;
const ready = () => setup({ action: "save", setup: { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", rsvpEnabled: true, published: true } });

describe("free trial RSVP: 50 invited people", () => {
  it("guests 1–50 get links; the 51st is refused with the trial message; the list itself can be 120", async () => {
    ok(await ready());
    expect(L).toBe(50);
    expect(TRIAL_RSVP_LIMIT_MESSAGE).toBe("You've used the 50-guest RSVP limit included in your free trial. Upgrade to continue sending invitations.");
    const ids = [];
    for (let i = 1; i <= 55; i += 1) ids.push(await addGuest(`Guest ${i}`));
    for (let i = 0; i < L; i += 1) ok(await guests({ action: "inviteLink", guestId: ids[i] }));
    expect(await usage()).toEqual({ used: L, limit: L });
    const r = await guests({ action: "inviteLink", guestId: ids[L] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "trial-rsvp-limit", message: TRIAL_RSVP_LIMIT_MESSAGE });
    // The direct API can't get around it either (replace on a guest without a link).
    expect((await guests({ action: "regenerateInvite", guestId: ids[L + 1] })).body.error).toBe("trial-rsvp-limit");
    expect(world.db.docs.get(`businesses/${W}/guestInvites/${ids[L]}`)).toBeUndefined();
    // More guests can still be added and prepared (120 guests, 50 / 50 used).
    for (let i = 56; i <= 120; i += 1) await addGuest(`Guest ${i}`);
    expect([...world.db.docs.keys()].filter((k) => k.startsWith(`businesses/${W}/guests/`)).length).toBe(120);
    expect(await usage()).toEqual({ used: L, limit: L });
  });

  it("copying, resending or replacing the same guest's link counts once", async () => {
    ok(await ready());
    const maria = await addGuest("Maria");
    const a = ok(await guests({ action: "inviteLink", guestId: maria }));
    ok(await guests({ action: "inviteLink", guestId: maria }));
    ok(await guests({ action: "inviteLink", guestId: maria }));
    const b = ok(await guests({ action: "regenerateInvite", guestId: maria }));
    expect(tokenOf(b)).not.toBe(tokenOf(a));
    expect(await usage()).toEqual({ used: 1, limit: L });
  });

  it("a party counts its people (John, Mary and their child = 3); a party that doesn't fit is refused; raising a party size counts too", async () => {
    ok(await ready());
    const fam = await addGuest("John, Mary & child", 3);
    expect(ok(await guests({ action: "inviteLink", guestId: fam })).trialRsvp).toEqual({ used: 3, limit: L });
    ok(await guests({ action: "inviteLink", guestId: await addGuest("Big family", 20) }));
    ok(await guests({ action: "inviteLink", guestId: await addGuest("Bigger family", 20) }));
    // 43 used: a party of 8 doesn't fit (51), a party of 7 does (50).
    expect((await guests({ action: "inviteLink", guestId: await addGuest("Eight", 8) })).body.error).toBe("trial-rsvp-limit");
    ok(await guests({ action: "inviteLink", guestId: await addGuest("Seven", 7) }));
    expect(await usage()).toEqual({ used: L, limit: L });
    // Raising an invited party past the limit is refused; the guest stays as it was.
    const up = await guests({ action: "update", guestId: fam, changes: { partySize: 4 } });
    expect(up.body.error).toBe("trial-rsvp-limit");
    expect(world.db.docs.get(`businesses/${W}/guests/${fam}`).partySize).toBe(3);
    // A guest without a link can be any size (not counted until invited).
    const later = await addGuest("Later", 5);
    ok(await guests({ action: "update", guestId: later, changes: { partySize: 8 } }));
    expect(await usage()).toEqual({ used: L, limit: L });
    // Removing a guest frees nothing (that invitation was sent).
    ok(await guests({ action: "remove", guestId: fam }));
    expect(await usage()).toEqual({ used: L, limit: L });
  });

  it("at 50 the first links keep working: open, RSVP, change the answer, same token", async () => {
    ok(await ready());
    const ids = [];
    for (let i = 1; i <= L; i += 1) ids.push(await addGuest(`Guest ${i}`));
    const tokens = [];
    for (const id of ids) tokens.push(tokenOf(ok(await guests({ action: "inviteLink", guestId: id }))));
    expect((await guests({ action: "inviteLink", guestId: await addGuest("Guest 51") })).status).toBe(409);
    // The trial's limit never closes RSVP for a guest who has a link.
    expect(ok(await invite({ action: "view", token: tokens[L - 1] })).invitation.rsvpOpen).toBe(true);
    expect(ok(await invite({ action: "view", token: tokens[0] })).invitation.guest.name).toBe("Guest 1");
    ok(await invite({ action: "respond", token: tokens[0], rsvp: { status: "attending", confirmed: 1 } }));
    ok(await invite({ action: "respond", token: tokens[0], rsvp: { status: "declined" } }));
    expect(world.db.docs.get(`businesses/${W}/guests/${ids[0]}`).rsvp).toBe("declined");
    expect(tokenOf(ok(await guests({ action: "inviteLink", guestId: ids[0] })))).toBe(tokens[0]);
  });

  it("paying (Super Admin access 3 months) lifts the limit at once; guests, answers and links stay", async () => {
    ok(await ready());
    const ids = [];
    for (let i = 1; i <= L + 1; i += 1) ids.push(await addGuest(`Guest ${i}`));
    const tokens = [];
    for (const id of ids.slice(0, L)) tokens.push(tokenOf(ok(await guests({ action: "inviteLink", guestId: id }))));
    ok(await invite({ action: "respond", token: tokens[3], rsvp: { status: "attending", confirmed: 1 } }));
    expect((await guests({ action: "inviteLink", guestId: ids[L] })).status).toBe(409);
    ok(await op({ action: "setTermAccess", businessId: W, access: 3, reason: "Paid by GCash" }));
    expect(await usage()).toBeNull();
    ok(await guests({ action: "inviteLink", guestId: ids[L] }));
    for (let i = 0; i < L; i += 1) expect(tokenOf(ok(await guests({ action: "inviteLink", guestId: ids[i] })))).toBe(tokens[i]);
    expect(world.db.docs.get(`businesses/${W}/guests/${ids[3]}`).rsvp).toBe("attending");
    ok(await invite({ action: "view", token: tokens[0] }));
  });

  // Links made at the same moment: tests/emulator/trial-rsvp-concurrency.test.js
  // (the real Firestore transactions).

  it("another wedding's token never opens here, and the wedding address alone shows nothing", async () => {
    ok(await ready());
    const t = tokenOf(ok(await guests({ action: "inviteLink", guestId: await addGuest("Ana") })));
    const bad = await invite({ action: "view", token: `${t.slice(0, -2)}xx` });
    expect(bad.status).toBe(404);
    expect(JSON.stringify(bad.body)).not.toMatch(/Ana/);
  });
});

// The guest page at a given moment (the deadline is a day in the wedding's timezone).
const inviteAt = async (now, body) => parse(await createInviteHandler({ getAdmin: async () => world, now: () => now })({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) }));
const totals = () => rsvpSummary(world.db.docs.get(`businesses/${W}/guestTotals/current`));

describe("RSVP open or closed, and why (2026-10-28)", () => {
  it("Shane (2 seats): RSVP switched off → closed for the guest; turned on → Yes / No from the same link, and the Owner's figures follow", async () => {
    ok(await setup({ action: "save", setup: { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", rsvpEnabled: false, published: true } }));
    const shane = await addGuest("Shane", 2);
    const token = tokenOf(ok(await guests({ action: "inviteLink", guestId: shane })));
    const closed = ok(await invite({ action: "view", token })).invitation;
    expect(closed).toMatchObject({ rsvpOpen: false, guest: { name: "Shane", seats: 2 } });
    expect(rsvpState(world.db.docs.get(`businesses/${W}/weddingSetup/current`), "2026-10-28")).toEqual({ open: false, reason: "off", deadline: null });
    expect((await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 2 } })).body.error).toBe("rsvp-closed");
    // Guests → "Turn on RSVP" (one setting): the same link now answers.
    ok(await setup({ action: "save", setup: { rsvpEnabled: true } }));
    expect(ok(await invite({ action: "view", token })).invitation.rsvpOpen).toBe(true);
    ok(await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 2 } }));
    expect(world.db.docs.get(`businesses/${W}/guests/${shane}`)).toMatchObject({ rsvp: "attending", confirmed: 2, rsvpSource: "guest" });
    expect(totals().attendingSeats).toBe(2);
    ok(await invite({ action: "respond", token, rsvp: { status: "declined" } }));
    expect(world.db.docs.get(`businesses/${W}/guests/${shane}`)).toMatchObject({ rsvp: "declined", confirmed: 0 });
    expect(totals().attendingSeats).toBe(0);
  });

  it("the deadline is the wedding's own day: open until 23:59 Manila on the deadline, closed from 00:00 the next day", async () => {
    ok(await op({ action: "setTermAccess", businessId: W, access: 6, reason: "paid" }));
    ok(await setup({ action: "save", setup: { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", rsvpDeadline: "2027-01-15", rsvpEnabled: true, published: true } }));
    const token = tokenOf(ok(await guests({ action: "inviteLink", guestId: await addGuest("Ana", 2) })));
    const last = new Date("2027-01-15T15:59:00Z"); // 23:59 Jan 15 in Manila (still Jan 15 in UTC too)
    const next = new Date("2027-01-15T16:00:00Z"); // 00:00 Jan 16 in Manila, but still Jan 15 in UTC
    expect(ok(await inviteAt(last, { action: "view", token })).invitation.rsvpOpen).toBe(true);
    ok(await inviteAt(last, { action: "respond", token, rsvp: { status: "attending", confirmed: 1 } }));
    expect(ok(await inviteAt(next, { action: "view", token })).invitation.rsvpOpen).toBe(false);
    const late = await inviteAt(next, { action: "respond", token, rsvp: { status: "declined" } });
    expect(late.status).toBe(409);
    expect(late.body.message).toBe("RSVPs for this wedding are closed. Please contact the couple.");
    // Early morning Manila time of the deadline day (still the 14th in UTC) is open.
    expect(ok(await inviteAt(new Date("2027-01-14T17:00:00Z"), { action: "view", token })).invitation.rsvpOpen).toBe(true);
    // "Close after the deadline" off: it stays open.
    ok(await setup({ action: "save", setup: { closeAfterDeadline: false } }));
    expect(ok(await inviteAt(next, { action: "view", token })).invitation.rsvpOpen).toBe(true);
    expect(rsvpState({ rsvpEnabled: true, rsvpDeadline: "2027-01-15" }, "2027-01-16")).toEqual({ open: false, reason: "deadline", deadline: "2027-01-15" });
    expect(rsvpState({ rsvpEnabled: true, rsvpDeadline: null }, "2030-01-01")).toEqual({ open: true, reason: null, deadline: null });
  });

  it("a trial that ENDED unpaid: the guest sees a neutral page (no trial / billing words); access restored → the same link works again", async () => {
    ok(await ready());
    const g = await addGuest("Reyes Family", 2);
    const token = tokenOf(ok(await guests({ action: "inviteLink", guestId: g })));
    const b = world.db.docs.get(`businesses/${W}`);
    world.db.docs.set(`businesses/${W}`, { ...b, subscription: { ...b.subscription, trialStartedAt: "2020-01-01", trialEndsAt: "2020-01-30" } });
    const r = await invite({ action: "view", token });
    expect(r.status).toBe(404);
    expect(r.body.message).toBe("This invitation is currently unavailable. Please contact the couple.");
    expect(JSON.stringify(r.body)).not.toMatch(/trial|paid|unpaid|subscription|billing|expired|upgrade/i);
    expect((await invite({ action: "respond", token, rsvp: { status: "declined" } })).body.message).toBe("This invitation is currently unavailable. Please contact the couple.");
    // Nothing was deleted: restoring access opens the very same token.
    expect(world.db.docs.get(`businesses/${W}/guestInvites/${g}`).token).toBe(token);
    ok(await op({ action: "setTermAccess", businessId: W, access: 3, reason: "Paid by GCash" }));
    expect(ok(await invite({ action: "view", token })).invitation.guest.name).toBe("Reyes Family");
  });
});

describe("the wedding link: Luna-made during the trial, chosen once paid (2026-10-28)", () => {
  it("a trial gets its names + a short random ending (never the clean name), can't choose or change it; after paying the couple chooses", async () => {
    ok(await ready());
    const made = world.db.docs.get(`businesses/${W}/weddingSetup/current`).weddingSlug;
    expect(made).toMatch(/^carlo-and-yanie-wedding-[0-9a-f]{4}$/);
    expect(world.db.docs.get("weddingSlugs/carlo-and-yanie-wedding")).toBeUndefined();
    expect(world.db.docs.get(`weddingSlugs/${made}`)).toMatchObject({ businessId: W });
    // Choosing a name (or the clean one) is refused on the server; nothing is reserved.
    for (const wanted of ["carlo-yanie", "carlo-and-yanie-wedding"]) {
      const r = await setup({ action: "save", setup: { weddingSlug: wanted } });
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: "slug-paid", message: SLUG_PAID_MESSAGE });
      expect(world.db.docs.get(`weddingSlugs/${wanted}`)).toBeUndefined();
    }
    // Saving the same link, or leaving it blank, keeps the Luna-made one.
    ok(await setup({ action: "save", setup: { weddingSlug: made, city: "Tagaytay" } }));
    ok(await setup({ action: "save", setup: { weddingSlug: null } }));
    expect(world.db.docs.get(`businesses/${W}/weddingSetup/current`).weddingSlug).toBe(made);
    const t = tokenOf(ok(await guests({ action: "inviteLink", guestId: await addGuest("Ana") })));
    expect(ok(await guests({ action: "inviteLink", guestId: Object.keys(world.db.docs.get(`businesses/${W}/weddingSetup/trialRsvp`).guests)[0] })).path).toBe(`/w/${made}/rsvp/${t}`);
    // Paid (3 or 6 months): the couple chooses; the old link still opens through its token.
    ok(await op({ action: "setTermAccess", businessId: W, access: 3, reason: "Paid by GCash" }));
    ok(await setup({ action: "save", setup: { weddingSlug: "carlo-yanie" } }));
    expect(world.db.docs.get("weddingSlugs/carlo-yanie")).toMatchObject({ businessId: W });
    expect(world.db.docs.get(`weddingSlugs/${made}`)).toBeUndefined();
    expect(ok(await invite({ action: "view", token: t })).invitation.path).toBe(`/w/carlo-yanie/rsvp/${t}`);
  });
});
