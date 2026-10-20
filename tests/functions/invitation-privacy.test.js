// Bridal invitation control + Super Admin privacy model (2026-10-20):
// invitation work is normal Super Admin work and shows only invitation
// content (previews use a SAMPLE guest, never a real guest or link); the
// customer's records are support access only (reasoned, read-only,
// time-limited, audited); the Master Backup lives inside support access.

import { describe, it, expect, beforeEach } from "vitest";
import { createInvitationDesignHandler } from "../../netlify/functions/invitation-design.js";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createInviteHandler } from "../../netlify/functions/invite.js";
import { createBackupHandler } from "../../netlify/functions/backup.js";
import { createBusiness, addMember, ensureAuthUser, setOperator } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request, roomForTeam } from "../helpers/tenants.js";

const NOW = new Date("2026-10-20T04:00:00Z");
const W = "biz-wed";
let world;
let u;
let clock = NOW;

beforeEach(async () => {
  clock = NOW;
  world = await buildWorld();
  await createBusiness({ ...world, name: "Reyes-Prado Wedding", planId: "bridal-plus", workspaceTemplateId: "bridal-expense", businessId: W });
  await roomForTeam(world, W);
  u = {};
  for (const [key, role] of [["camille", "owner"], ["mon", "manager"]]) {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@priv.test`, name: key });
    await addMember({ ...world, businessId: W, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  }
  for (const key of ["ops", "ops2"]) {
    const op = await ensureAuthUser({ auth: world.auth, email: `${key}@luna.test`, name: key });
    await setOperator({ ...world, email: op.email, status: "active", reason: "test operator" });
    u[key] = op.uid;
  }
});

const deps = () => ({ getAdmin: async () => world, now: () => clock });
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const design = async (body, uid = u.ops) => parse(await createInvitationDesignHandler(deps())({ ...request({ uid, method: "POST" }), body: JSON.stringify(body) }));
const op = async (body, uid = u.ops) => parse(await createOperatorHandler(deps())({ ...request({ uid }), httpMethod: "POST", body: JSON.stringify(body) }));
const backup = async (body, uid = u.ops) => createBackupHandler(deps())({ ...request({ uid, method: "POST" }), body: JSON.stringify(body) });
const H = { guests: createGuestsHandler, setup: createWeddingSetupHandler };
const owner = async (kind, body, uid = u.camille) => parse(await H[kind](deps())({ ...request({ uid, businessId: W, method: "POST" }), body: JSON.stringify(body) }));
const invite = async (body) => parse(await createInviteHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) }));
const audits = (type) => [...world.db.docs.entries()].filter(([k, v]) => v?.type === type && (k.startsWith("platformAudit/") || k.startsWith(`businesses/${W}/auditLog/`)));

async function wedding() {
  ok(await owner("setup", { action: "save", setup: { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", rsvpEnabled: true, weddingSlug: "carloyanieforever", story: "We met at a wedding." } }));
  const g = ok(await owner("guests", { action: "create", guest: { name: "Sanrah Realguest", category: "friends", side: "bride", partySize: 5 } }), 201).guestId;
  const path = ok(await owner("guests", { action: "inviteLink", guestId: g })).path;
  return { g, token: path.split("/").pop() };
}

describe("invitation work: only invitation content, a sample guest", () => {
  it("Preview (draft and published): the whole invitation for a SAMPLE guest; no real guest, token or private wedding data", async () => {
    const { token } = await wedding();
    // A private field next to the invitation fields never leaves the workspace.
    world.db.docs.set(`businesses/${W}/weddingSetup/current`, { ...world.db.docs.get(`businesses/${W}/weddingSetup/current`), privateNote: "budget is tight" });
    for (const which of ["draft", "live"]) {
      const r = ok(await design({ action: "sample", businessId: W, which }));
      expect(r.invitation.guest).toEqual({ name: "Sample Guest", seats: 2, rsvp: "awaiting", confirmed: 0, roles: [] });
      expect(r.invitation).toMatchObject({ sample: true, wedding: { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14" } });
      const text = JSON.stringify(r);
      expect(text).not.toMatch(/Sanrah|Realguest|budget is tight|privateNote/);
      expect(text).not.toContain(token);
    }
    // Repeatable and writes nothing.
    const before = world.db.docs.size;
    ok(await design({ action: "sample", businessId: W, which: "draft" }));
    expect(world.db.docs.size).toBe(before);
    // The design workspace too: invitation fields only.
    const w = ok(await design({ action: "get", businessId: W }));
    expect(w.content.setup).not.toHaveProperty("privateNote");
    expect(JSON.stringify(w)).not.toMatch(/Sanrah|budget is tight/);
  });

  it("the business page: an Invitation summary (couple, Custom, status, last updated) and nothing else of the wedding", async () => {
    await wedding();
    const d = ok(await op({ action: "business", businessId: W }));
    expect(d.invitation).toMatchObject({ coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", type: "custom", productName: "Luna Bridal Custom", status: "draft", live: "standard" });
    expect(JSON.stringify(d)).not.toMatch(/Sanrah|Realguest|We met at a wedding/);
    expect(d.support).toBeNull();
  });

  it("Publish makes the draft live; guest links keep working; later draft edits stay hidden until published again", async () => {
    const { token } = await wedding();
    ok(await design({ action: "saveDraft", businessId: W, config: { templateId: "classic", texts: { scriptLine: "first design" } } }));
    expect(ok(await invite({ action: "view", token })).invitation.design).toBeNull();
    ok(await design({ action: "publish", businessId: W }));
    const v1 = ok(await invite({ action: "view", token })).invitation;
    expect(v1.design.config.texts.scriptLine).toBe("first design");
    expect(v1.guest.name).toBe("Sanrah Realguest");
    ok(await design({ action: "saveDraft", businessId: W, config: { templateId: "classic", texts: { scriptLine: "second idea" } } }));
    expect(ok(await invite({ action: "view", token })).invitation.design.config.texts.scriptLine).toBe("first design");
    expect(ok(await design({ action: "sample", businessId: W, which: "draft" })).invitation.design.config.texts.scriptLine).toBe("second idea");
    expect(ok(await design({ action: "sample", businessId: W, which: "live" })).invitation.design.config.texts.scriptLine).toBe("first design");
    const d = ok(await op({ action: "business", businessId: W }));
    expect(d.invitation).toMatchObject({ status: "published", unpublishedChanges: true, publishedVersion: 1 });
    ok(await design({ action: "publish", businessId: W }));
    expect(ok(await invite({ action: "view", token })).invitation.design.config.texts.scriptLine).toBe("second idea");
    expect(audits("invitation.published").length).toBeGreaterThanOrEqual(2);
  });

  it("customers can't use Super Admin invitation routes (preview, edit, publish)", async () => {
    await wedding();
    for (const body of [{ action: "sample", businessId: W, which: "draft" }, { action: "get", businessId: W }, { action: "saveDraft", businessId: W, config: { templateId: "standard" } }, { action: "publish", businessId: W }]) {
      for (const uid of [u.camille, u.mon]) expect((await design(body, uid)).status, `${body.action} ${uid}`).toBe(403);
    }
    expect((await op({ action: "business", businessId: W }, u.camille)).status).toBe(403);
    expect((await op({ action: "supportStart", businessId: W, reason: "I am the owner" }, u.camille)).status).toBe(403);
  });
});

describe("support access: explicit, reasoned, read-only, time-limited, audited", () => {
  it("start needs a reason; reads one area at a time; every start, view and exit is recorded for Luna and the business", async () => {
    await wedding();
    expect((await op({ action: "supportStart", businessId: W, reason: "hi" })).body.error).toBe("reason-required");
    const s = ok(await op({ action: "supportStart", businessId: W, reason: "Owner says RSVP totals look wrong (ticket 12)" }));
    expect(s).toMatchObject({ mode: "read-only" });
    expect(s.areas.map((a) => a.id)).toEqual(expect.arrayContaining(["guests", "weddingTasks", "weddingSuppliers", "weddingSetup"]));
    expect(s.areas.map((a) => a.id)).not.toEqual(expect.arrayContaining(["guestInvites", "invitations", "members"]));
    const started = audits("support.started");
    expect(started).toHaveLength(2); // platformAudit + the business's own log
    expect(started[0][1]).toMatchObject({ reason: "Owner says RSVP totals look wrong (ticket 12)", sessionId: s.sessionId, mode: "read-only", actor: "ops@luna.test" });
    expect((await op({ action: "business", businessId: W })).body.support).toMatchObject({ sessionId: s.sessionId, mode: "read-only" });
    const g = ok(await op({ action: "supportRead", sessionId: s.sessionId, businessId: W, area: "guests" }));
    expect(g.rows.map((r) => r.name)).toContain("Sanrah Realguest");
    expect(audits("support.viewed")[0][1]).toMatchObject({ area: "guests", sessionId: s.sessionId });
    expect((await op({ action: "supportRead", sessionId: s.sessionId, businessId: W, area: "guestInvites" })).status).toBe(400);
    expect((await op({ action: "supportRead", sessionId: s.sessionId, businessId: W, area: "orders" })).status).toBe(400);
    // Another operator can't ride someone's session.
    expect((await op({ action: "supportRead", sessionId: s.sessionId, businessId: W, area: "guests" }, u.ops2)).status).toBe(403);
    ok(await op({ action: "supportEnd", sessionId: s.sessionId }));
    expect(audits("support.ended")).toHaveLength(2);
    expect((await op({ action: "supportRead", sessionId: s.sessionId, businessId: W, area: "guests" })).body.error).toBe("session-ended");
    expect(world.db.docs.get(`supportSessions/${s.sessionId}`)).toMatchObject({ businessId: W, mode: "read-only", endedBy: "ops@luna.test" });
  });

  it("a session expires after 30 minutes", async () => {
    const s = ok(await op({ action: "supportStart", businessId: W, reason: "Checking an import problem" }));
    // 31 minutes later: the session's end has passed.
    const ref = `supportSessions/${s.sessionId}`;
    world.db.docs.set(ref, { ...world.db.docs.get(ref), expiresAt: new Date(Date.now() - 60_000) });
    expect((await op({ action: "supportRead", sessionId: s.sessionId, businessId: W, area: "guests" })).body.error).toBe("session-ended");
    expect((await op({ action: "business", businessId: W })).body.support).toBeNull();
  });

  it("the Master Backup (every record) only inside the operator's own open support session, recorded with the reason", async () => {
    expect((await backup({ businessId: W })).statusCode).toBe(403);
    const s = ok(await op({ action: "supportStart", businessId: W, reason: "Owner asked for a full copy (ticket 40)" }));
    expect((await backup({ businessId: W, supportSessionId: s.sessionId }, u.ops2)).statusCode).toBe(403);
    const r = await backup({ businessId: W, supportSessionId: s.sessionId });
    expect(r.statusCode).toBe(200);
    expect(audits("backup.downloaded")[0][1]).toMatchObject({ sessionId: s.sessionId, reason: "Owner asked for a full copy (ticket 40)" });
    ok(await op({ action: "supportEnd", sessionId: s.sessionId }));
    expect((await backup({ businessId: W, supportSessionId: s.sessionId })).statusCode).toBe(403);
  });
});
