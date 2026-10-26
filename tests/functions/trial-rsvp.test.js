// Free trial RSVP (2026-10-26): a trial wedding sends real RSVP links to at
// most 20 invited people. One guest record = one party, counted as its party
// size, once (copy / resend / replace count nothing more). The guest list may
// be larger; the rest wait. The server enforces it (no browser trust), the
// first 20 keep working, and paying lifts the limit with the same links.

import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createInviteHandler } from "../../netlify/functions/invite.js";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { createBusiness, addMember, ensureAuthUser, setOperator } from "../../netlify/functions/_lib/provisioning.js";
import { TRIAL_RSVP_GUESTS, TRIAL_RSVP_LIMIT_MESSAGE } from "../../shared/wedding.js";

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

describe("free trial RSVP: 20 invited people", () => {
  it("guests 1–20 get links; the 21st is refused with the trial message; the list itself can be 100", async () => {
    ok(await ready());
    expect(TRIAL_RSVP_GUESTS).toBe(20);
    const ids = [];
    for (let i = 1; i <= 25; i += 1) ids.push(await addGuest(`Guest ${i}`));
    for (let i = 0; i < 20; i += 1) ok(await guests({ action: "inviteLink", guestId: ids[i] }));
    expect(await usage()).toEqual({ used: 20, limit: 20 });
    const r = await guests({ action: "inviteLink", guestId: ids[20] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "trial-rsvp-limit", message: TRIAL_RSVP_LIMIT_MESSAGE });
    // The direct API can't get around it either (replace on a guest without a link).
    expect((await guests({ action: "regenerateInvite", guestId: ids[21] })).body.error).toBe("trial-rsvp-limit");
    expect(world.db.docs.get(`businesses/${W}/guestInvites/${ids[20]}`)).toBeUndefined();
    // More guests can still be added and prepared.
    for (let i = 26; i <= 100; i += 1) await addGuest(`Guest ${i}`);
    expect([...world.db.docs.keys()].filter((k) => k.startsWith(`businesses/${W}/guests/`)).length).toBe(100);
    expect(await usage()).toEqual({ used: 20, limit: 20 });
  });

  it("copying, resending or replacing the same guest's link counts once", async () => {
    ok(await ready());
    const maria = await addGuest("Maria");
    const a = ok(await guests({ action: "inviteLink", guestId: maria }));
    ok(await guests({ action: "inviteLink", guestId: maria }));
    ok(await guests({ action: "inviteLink", guestId: maria }));
    const b = ok(await guests({ action: "regenerateInvite", guestId: maria }));
    expect(tokenOf(b)).not.toBe(tokenOf(a));
    expect(await usage()).toEqual({ used: 1, limit: 20 });
  });

  it("a party counts its people (John, Mary and their child = 3); a party that doesn't fit is refused; raising a party size counts too", async () => {
    ok(await ready());
    const fam = await addGuest("John, Mary & child", 3);
    expect(ok(await guests({ action: "inviteLink", guestId: fam })).trialRsvp).toEqual({ used: 3, limit: 20 });
    const big = await addGuest("Big family", 17);
    ok(await guests({ action: "inviteLink", guestId: big }));
    expect(await usage()).toEqual({ used: 20, limit: 20 });
    // Raising an invited party past the limit is refused; the guest stays as it was.
    const up = await guests({ action: "update", guestId: fam, changes: { partySize: 4 } });
    expect(up.body.error).toBe("trial-rsvp-limit");
    expect(world.db.docs.get(`businesses/${W}/guests/${fam}`).partySize).toBe(3);
    // A guest without a link can be any size (not counted until invited).
    const later = await addGuest("Later", 5);
    ok(await guests({ action: "update", guestId: later, changes: { partySize: 8 } }));
    expect(await usage()).toEqual({ used: 20, limit: 20 });
    // Removing a guest frees nothing (that invitation was sent).
    ok(await guests({ action: "remove", guestId: fam }));
    expect(await usage()).toEqual({ used: 20, limit: 20 });
  });

  it("at 20 the first links keep working: open, RSVP, change the answer, same token", async () => {
    ok(await ready());
    const ids = [];
    for (let i = 1; i <= 20; i += 1) ids.push(await addGuest(`Guest ${i}`));
    const tokens = [];
    for (const id of ids) tokens.push(tokenOf(ok(await guests({ action: "inviteLink", guestId: id }))));
    expect((await guests({ action: "inviteLink", guestId: await addGuest("Guest 21") })).status).toBe(409);
    expect(ok(await invite({ action: "view", token: tokens[0] })).invitation.guest.name).toBe("Guest 1");
    ok(await invite({ action: "respond", token: tokens[0], rsvp: { status: "attending", confirmed: 1 } }));
    ok(await invite({ action: "respond", token: tokens[0], rsvp: { status: "declined" } }));
    expect(world.db.docs.get(`businesses/${W}/guests/${ids[0]}`).rsvp).toBe("declined");
    expect(tokenOf(ok(await guests({ action: "inviteLink", guestId: ids[0] })))).toBe(tokens[0]);
  });

  it("paying (Super Admin access 3 months) lifts the limit at once; guests, answers and links stay", async () => {
    ok(await ready());
    const ids = [];
    for (let i = 1; i <= 21; i += 1) ids.push(await addGuest(`Guest ${i}`));
    const tokens = [];
    for (const id of ids.slice(0, 20)) tokens.push(tokenOf(ok(await guests({ action: "inviteLink", guestId: id }))));
    ok(await invite({ action: "respond", token: tokens[3], rsvp: { status: "attending", confirmed: 1 } }));
    expect((await guests({ action: "inviteLink", guestId: ids[20] })).status).toBe(409);
    ok(await op({ action: "setTermAccess", businessId: W, access: 3, reason: "Paid by GCash" }));
    expect(await usage()).toBeNull();
    ok(await guests({ action: "inviteLink", guestId: ids[20] }));
    for (let i = 0; i < 20; i += 1) expect(tokenOf(ok(await guests({ action: "inviteLink", guestId: ids[i] })))).toBe(tokens[i]);
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
