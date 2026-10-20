// Owner-pilot Bridal: Wedding Setup, personal invitation links, guest RSVP
// (the same guest record, history with source, totals, seating, deadline,
// notifications) and the Master Backup (every workspace).

import { describe, it, expect, beforeEach } from "vitest";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createInviteHandler } from "../../netlify/functions/invite.js";
import { createBackupHandler } from "../../netlify/functions/backup.js";
import { createExpensesHandler } from "../../netlify/functions/expenses.js";
import { createBudgetHandler } from "../../netlify/functions/budget.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { hashInviteToken } from "../../netlify/functions/_lib/invitations.js";
import { deleteBusiness, restoreBusiness } from "../../netlify/functions/_lib/lifecycle.js";
import { buildWorld, request, asOperator, roomForTeam } from "../helpers/tenants.js";
import { rsvpSummary, rsvpOpen, validateWeddingSetup } from "../../shared/wedding.js";
import { readXlsx } from "../../shared/xlsx.js";

let NOW = new Date("2026-10-16T04:00:00Z"); // Oct 16, 12:00 Manila
const W = "biz-wed";
const W2 = "biz-wed-2";
let world;
let u;

beforeEach(async () => {
  NOW = new Date("2026-10-16T04:00:00Z");
  world = await buildWorld();
  await createBusiness({ ...world, name: "Reyes-Prado Wedding", planId: "bridal-plus", workspaceTemplateId: "bridal-expense", businessId: W }); await roomForTeam(world, W);
  await createBusiness({ ...world, name: "Cruz Wedding", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W2 }); await roomForTeam(world, W2);
  u = {};
  const add = async (key, businessId, role) => {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@inv.test`, name: key });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  };
  await add("camille", W, "owner");
  await add("mon", W, "manager");
  await add("helper", W, "staff");
  await add("other", W2, "owner");
});

const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const H = { guests: createGuestsHandler, setup: createWeddingSetupHandler, expenses: createExpensesHandler, budget: createBudgetHandler };
async function api(kind, uid, body, businessId = W) {
  const res = await H[kind](deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function guest(body) {
  const res = await createInviteHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const docAt = (p, businessId = W) => world.db.docs.get(`businesses/${businessId}/${p}`);
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const SETUP = { coupleNames: "Camille & Carlo", weddingDate: "2027-12-12", ceremonyTime: "15:00", ceremonyVenue: "Example Church", ceremonyAddress: "Taguig City", receptionTime: "17:30", receptionVenue: "Example Garden", receptionAddress: "Taguig City", dressCode: "Formal", welcomeMessage: "Together with our families, we invite you to celebrate our wedding day.", rsvpDeadline: "2026-11-15", rsvpEnabled: true };
async function maria() {
  ok(await api("setup", u.camille, { action: "save", setup: SETUP }));
  const g = ok(await api("guests", u.camille, { action: "create", guest: { name: "Maria Santos", category: "family", side: "bride", partySize: 2 } }), 201).guestId;
  const link = ok(await api("guests", u.camille, { action: "inviteLink", guestId: g }));
  return { g, token: link.path.split("/").pop(), path: link.path };
}

describe("Wedding Setup", () => {
  it("controlled fields only; Staff can't change it; RSVP open follows the switch and the deadline", async () => {
    ok(await api("setup", u.camille, { action: "save", setup: SETUP }));
    expect(ok(await api("setup", u.mon, { action: "get" })).setup).toMatchObject({ coupleNames: "Camille & Carlo", rsvpDeadline: "2026-11-15", rsvpEnabled: true });
    expect((await api("setup", u.camille, { action: "save", setup: { theme: "pink" } })).status).toBe(400);
    expect((await api("setup", u.camille, { action: "save", setup: { ceremonyMap: "javascript:alert(1)" } })).status).toBe(400);
    expect((await api("setup", u.camille, { action: "hero", dataUrl: "data:text/html;base64,AAAA" })).status).toBe(400);
    expect((await api("setup", u.helper, { action: "save", setup: { coupleNames: "X" } })).status).toBe(403);
    expect(validateWeddingSetup({ ceremonyTime: "15:00", closeAfterDeadline: false })).toEqual({ ceremonyTime: "15:00", closeAfterDeadline: false });
    expect([rsvpOpen(SETUP, "2026-11-15"), rsvpOpen(SETUP, "2026-11-16"), rsvpOpen({ ...SETUP, closeAfterDeadline: false }, "2026-11-16"), rsvpOpen({ ...SETUP, rsvpEnabled: false }, "2026-10-01")]).toEqual([true, false, true, false]);
  });
});

describe("invitation links: secure, revocable, tenant-safe", () => {
  it("a high-entropy token (not the guest id) opens THIS party only; only its hash is the lookup; Staff can't make links", async () => {
    const { g, token, path } = await maria();
    expect(path).toBe(`/w/camille-and-carlo-wedding/invite/${token}`); // friendly slug from the couple names
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(token).not.toContain(g);
    expect(world.db.docs.get(`invitations/${hashInviteToken(token)}`)).toMatchObject({ businessId: W, guestId: g });
    expect(world.db.docs.has(`invitations/${token}`)).toBe(false);
    // The same link comes back (made once).
    expect(ok(await api("guests", u.mon, { action: "inviteLink", guestId: g })).path).toBe(path);
    const v = ok(await guest({ action: "view", token })).invitation;
    expect(v.guest).toEqual({ name: "Maria Santos", seats: 2, rsvp: "awaiting", confirmed: 0, roles: [] });
    expect(v.wedding).toMatchObject({ coupleNames: "Camille & Carlo", ceremonyVenue: "Example Church", rsvpDeadline: "2026-11-15" });
    expect(v.rsvpOpen).toBe(true);
    expect(JSON.stringify(v)).not.toContain(g);
    expect(JSON.stringify(v)).not.toContain(W);
    expect((await api("guests", u.helper, { action: "inviteLink", guestId: g })).status).toBe(403);
  });

  it("Regenerate: the old link stops working at once, the new one works", async () => {
    const { g, token } = await maria();
    const fresh = ok(await api("guests", u.camille, { action: "regenerateInvite", guestId: g })).path.split("/").pop();
    expect(fresh).not.toBe(token);
    const old = await guest({ action: "view", token });
    expect(old.status).toBe(404);
    expect(old.body.message).toMatch(/isn't valid/);
    expect((await guest({ action: "respond", token, rsvp: { status: "declined" } })).status).toBe(404);
    expect(ok(await guest({ action: "view", token: fresh })).invitation.guest.name).toBe("Maria Santos");
    expect(docAt(`guests/${g}`).history.at(-1).label).toBe("Invitation link replaced (the old link no longer works)");
  });

  it("a deleted wedding (Super Admin, recoverable): its links stop working at once; Restore brings them back", async () => {
    const { token } = await maria();
    await deleteBusiness({ db: world.db, FieldValue: world.admin.firestore.FieldValue, businessId: W, confirmName: "Reyes-Prado Wedding", operator: "ops@luna.test" });
    expect((await guest({ action: "view", token })).status).toBe(404);
    expect((await guest({ action: "respond", token, rsvp: { status: "declined" } })).status).toBe(404);
    await restoreBusiness({ db: world.db, FieldValue: world.admin.firestore.FieldValue, businessId: W, operator: "ops@luna.test" });
    expect(ok(await guest({ action: "view", token })).invitation.guest.name).toBe("Maria Santos");
  });

  it("bad / guessed tokens and other weddings' guests: the same 'not valid' answer; one wedding can't make links for another's guests", async () => {
    const { g } = await maria();
    for (const token of ["", "x", "A".repeat(32), g, `${g}`.padEnd(32, "0")]) expect((await guest({ action: "view", token })).status, token).toBe(404);
    expect((await guest({ action: "view", token: "A".repeat(32), extra: 1 })).status).toBe(400);
    expect((await api("guests", u.other, { action: "inviteLink", guestId: g }, W2)).status).toBe(404);
  });
});

describe("guest RSVP updates the SAME guest record", () => {
  it("Accept 2: guest, totals (overall + category) update; history keeps source + from/to; a later Owner change keeps the guest's line", async () => {
    const { g, token } = await maria();
    expect((await guest({ action: "respond", token, rsvp: { status: "attending", confirmed: 3 } })).status).toBe(400); // > invited seats
    expect((await guest({ action: "respond", token, rsvp: { status: "awaiting" } })).status).toBe(400);
    const r = ok(await guest({ action: "respond", token, rsvp: { status: "attending", confirmed: 2 } }));
    expect(r).toMatchObject({ rsvp: "attending", confirmed: 2, name: "Maria Santos" });
    expect(docAt(`guests/${g}`)).toMatchObject({ rsvp: "attending", confirmed: 2, rsvpSource: "guest", rsvpDate: "2026-10-16" });
    expect(rsvpSummary(docAt("guestTotals/current"))).toMatchObject({ attending: 1, attendingSeats: 2, awaiting: 0 });
    expect(docAt("guestTotals/current").byCategory.family).toMatchObject({ attendingSeats: 2, invitedSeats: 2 });
    expect(docAt(`guests/${g}`).history.at(-1)).toMatchObject({ label: "Guest responded: Attending · 2 of 2", source: "guest", from: { rsvp: "awaiting", confirmed: 0 }, to: { status: "attending", confirmed: 2 } });
    // Owner corrects it later: both lines stay.
    ok(await api("guests", u.camille, { action: "setRsvp", guestId: g, rsvp: { status: "attending", confirmed: 1 } }));
    const labels = docAt(`guests/${g}`).history.map((h) => h.label);
    expect(labels.slice(-2)).toEqual(["Guest responded: Attending · 2 of 2", "Owner changed: Attending 2 → Attending 1"]);
    expect(docAt(`guests/${g}`).history.at(-1).source).toBe("owner");
  });

  it("Decline frees the table seat; the owners get one informational notification (Recent, not needs-attention)", async () => {
    const { g, token } = await maria();
    ok(await guest({ action: "respond", token, rsvp: { status: "attending", confirmed: 2 } }));
    const t1 = ok(await api("guests", u.camille, { action: "createTable", table: { name: "Table 1", capacity: 8 } }), 201).tableId;
    ok(await api("guests", u.camille, { action: "seat", guestId: g, tableId: t1 }));
    NOW = new Date("2026-10-17T04:00:00Z");
    ok(await guest({ action: "respond", token, rsvp: { status: "declined" } }));
    expect(docAt(`guests/${g}`)).toMatchObject({ rsvp: "declined", confirmed: 0, tableId: null });
    expect(docAt(`guests/${g}`).history.at(-1).label).toBe("Guest changed RSVP: 2 of 2 → Declined · removed from their table");
    const inbox = [...world.db.docs.entries()].filter(([k, v]) => k.startsWith(`businesses/${W}/members/${u.camille}/inbox/`) && v.type === "guest.rsvp").map(([, v]) => v.title);
    expect(inbox).toEqual(expect.arrayContaining(["Maria Santos RSVP'd Attending · 2", "Maria Santos RSVP'd Declined"]));
    expect([...world.db.docs.keys()].some((k) => k.startsWith(`businesses/${W}/members/${u.helper}/inbox/`))).toBe(false); // staff: no guests.view
  });

  it("the deadline closes guest RSVPs (the Owner can still change them); RSVP off closes them too; an unchanged answer changes nothing", async () => {
    const { g, token } = await maria();
    ok(await guest({ action: "respond", token, rsvp: { status: "attending", confirmed: 1 } }));
    const rev = docAt(`guests/${g}`).revision;
    expect(ok(await guest({ action: "respond", token, rsvp: { status: "attending", confirmed: 1 } })).unchanged).toBe(true);
    expect(docAt(`guests/${g}`).revision).toBe(rev);
    NOW = new Date("2026-11-16T04:00:00Z");
    const late = await guest({ action: "respond", token, rsvp: { status: "declined" } });
    expect([late.status, late.body.message]).toEqual([409, "RSVPs for this wedding are closed. Please contact the couple."]);
    expect(ok(await guest({ action: "view", token })).invitation.rsvpOpen).toBe(false);
    ok(await api("guests", u.camille, { action: "setRsvp", guestId: g, rsvp: { status: "declined" } }));
    ok(await api("setup", u.camille, { action: "save", setup: { rsvpDeadline: null, rsvpEnabled: false } }));
    expect((await guest({ action: "respond", token, rsvp: { status: "attending", confirmed: 1 } })).status).toBe(409);
  });
});

describe("Master Backup", () => {
  async function backup(uid, businessId = W) {
    const res = await createBackupHandler(deps())(asOperator(world, businessId));
    return res;
  }
  const sheetNames = (bytes) => {
    const out = [];
    for (const name of ["Export Info", "Wedding Setup", "Budget", "Suppliers", "Supplier Payments", "Expenses", "Tasks", "Guest Categories", "Guests", "RSVP History", "Tables", "Seating Assignments", "Users & Memberships", "Audit log"]) {
      try {
        readXlsx(bytes, { sheet: name, maxRows: 100000 });
        out.push(name);
      } catch {
        /* missing */
      }
    }
    return out;
  };

  it("Bridal: every expected sheet; removed records included; RSVP history with source; no invitation token or hash anywhere", async () => {
    const { g, token } = await maria();
    ok(await guest({ action: "respond", token, rsvp: { status: "attending", confirmed: 2 } }));
    const cat = ok(await api("budget", u.camille, { action: "createCategory", category: { name: "Flowers", budget: null } }), 201).categoryId;
    const e = ok(await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-15", method: "cash", category: cat, amount: 50000, payee: "Petal Shop" } }), 201).expenseId;
    ok(await api("expenses", u.camille, { action: "remove", expenseId: e, reason: "Typo" }));
    const res = await backup(u.camille);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Disposition"]).toMatch(/Reyes-Prado-Wedding-Master-Backup-2026-10-16\.xlsx/);
    const bytes = Buffer.from(res.body, "base64");
    expect(sheetNames(bytes)).toEqual(["Export Info", "Wedding Setup", "Budget", "Suppliers", "Supplier Payments", "Expenses", "Tasks", "Guest Categories", "Guests", "RSVP History", "Tables", "Seating Assignments", "Users & Memberships", "Audit log"]);
    const expenses = readXlsx(bytes, { sheet: "Expenses" });
    expect(expenses.rows[0]).toEqual(expect.arrayContaining(["id", "amount", "category", "status", "payee"]));
    expect(expenses.rows.slice(1).map((r) => r[expenses.rows[0].indexOf("status")])).toEqual(["removed"]); // historical kept
    const rsvp = readXlsx(bytes, { sheet: "RSVP History" }).rows;
    expect(rsvp[1]).toEqual([g, "Maria Santos", "2026-10-16T04:00:00.000Z", "guest", "", "awaiting", "0", "attending", "2", "Guest responded: Attending · 2 of 2"]);
    const all = Buffer.from(bytes).toString("latin1");
    expect(all.includes(token)).toBe(false);
    expect(all.includes(hashInviteToken(token))).toBe(false);
    const users = readXlsx(bytes, { sheet: "Users & Memberships" }).rows;
    expect(users.length).toBe(4); // header + camille, mon, helper
  });

  it("reads every page (no truncation): 1,200 guests all come out", async () => {
    const base = world.db;
    for (let i = 0; i < 1200; i++) base.docs.set(`businesses/${W}/guests/g${String(i).padStart(5, "0")}`, { name: `Guest ${i}`, partySize: 1, rsvp: "awaiting", confirmed: 0, history: [] });
    const res = await backup(u.camille);
    const rows = readXlsx(Buffer.from(res.body, "base64"), { sheet: "Guests", maxRows: 5000 }).rows;
    expect(rows.length).toBe(1201);
  });

  it("Luna Super Admin only: the Owner, an Admin and staff get 403 even for their own business; the operator gets only the named business's data; other workspaces get their own sheets", async () => {
    const asTenant = (uid, businessId = W) => createBackupHandler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify({ businessId }) });
    for (const uid of [u.camille, u.mon, u.helper]) expect((await asTenant(uid)).statusCode).toBe(403);
    expect((await asTenant(world.uids.ownera, "biz-a")).statusCode).toBe(403);
    expect((await asTenant(u.camille, W2)).statusCode).toBe(403);
    expect((await createBackupHandler(deps())({ ...request({ method: "POST" }), body: JSON.stringify({ businessId: W }) })).statusCode).toBe(401);
    world.db.seed("operators/opDisabled1", { email: "old@luna.test", role: "superadmin", status: "disabled" });
    expect((await createBackupHandler(deps())({ ...request({ uid: "opDisabled1", method: "POST" }), body: JSON.stringify({ businessId: W }) })).statusCode).toBe(403);
    const op = asOperator(world, W);
    expect((await createBackupHandler(deps())({ ...op, body: JSON.stringify({ businessId: "../x" }) })).statusCode).toBe(400);
    expect((await createBackupHandler(deps())({ ...op, body: JSON.stringify({ businessId: "no-such-biz" }) })).statusCode).toBe(404);
    expect((await createBackupHandler(deps())({ ...op, body: JSON.stringify({ businessId: W, extra: 1 }) })).statusCode).toBe(400);
    // Each operator download is recorded (business audit log + platformAudit).
    expect((await backup(null, W)).statusCode).toBe(200);
    expect([...world.db.docs.entries()].some(([k, v]) => k.startsWith(`businesses/${W}/auditLog/`) && v.type === "backup.downloaded" && v.operator?.uid === "opLunaBackup1")).toBe(true);
    expect([...world.db.docs.entries()].some(([k, v]) => k.startsWith("platformAudit/") && v.type === "backup.downloaded" && v.businessId === W)).toBe(true);
    const theirs = Buffer.from((await backup(u.other, W2)).body, "base64");
    expect(readXlsx(theirs, { sheet: "Users & Memberships" }).rows.flat()).not.toContain("camille@inv.test");
    const dist = Buffer.from((await backup(world.uids.ownera, "biz-a")).body, "base64");
    for (const s of ["Orders", "Payments", "Products", "Customers", "Expenses", "Users & Memberships", "Audit log"]) expect(() => readXlsx(dist, { sheet: s }), s).not.toThrow();
    expect(() => readXlsx(dist, { sheet: "Guests" })).toThrow();
  });
});
