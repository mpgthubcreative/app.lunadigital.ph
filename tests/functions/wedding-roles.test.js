// Owner-pilot Bridal: wedding roles on guest records (single / many, change
// person / role, removing keeps the guest and RSVP, tenant isolation, the
// Master Backup sheet) and requirement tasks (source, Bride & Groom marks).

import { describe, it, expect, beforeEach } from "vitest";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createWeddingTasksHandler } from "../../netlify/functions/wedding-tasks.js";
import { createBackupHandler } from "../../netlify/functions/backup.js";
import { createInviteHandler } from "../../netlify/functions/invite.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request, asOperator, roomForTeam } from "../helpers/tenants.js";
import { validateRole, roleKey, rolesPlan, categoryForRole, peopleOf, peopleWithoutRole, attendingNames } from "../../shared/wedding-roles.js";
import { seatingPlan, SEATING_DOC_ID } from "../../shared/wedding.js";
import { readXlsx } from "../../shared/xlsx.js";

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
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@roles.test`, name: key });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  };
  await add("camille", W, "owner");
  await add("helper", W, "staff");
  await add("other", W2, "owner");
});

const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const H = { guests: createGuestsHandler, tasks: createWeddingTasksHandler, setup: createWeddingSetupHandler };
async function api(kind, uid, body, businessId = W) {
  const res = await H[kind](deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const doc = (p, businessId = W) => world.db.docs.get(`businesses/${businessId}/${p}`);
const guest = async (name, category = "family", partySize = 2, uid = u.camille, businessId = W) => ok(await api("guests", uid, { action: "create", guest: { name, category, side: "bride", partySize } }, businessId), 201).guestId;
const assign = (guestId, role, uid = u.camille, businessId = W) => api("guests", uid, { action: "assignRole", guestId, role }, businessId);

describe("wedding roles (on the guest record)", () => {
  it("roles: built-in or custom; keys; category for a new guest from a role", () => {
    expect(validateRole({ id: "principal_sponsor" })).toEqual({ id: "principal_sponsor" });
    expect(validateRole({ id: "custom", label: "  Program   host " })).toEqual({ id: "custom", label: "Program host" });
    expect(() => validateRole({ id: "king" })).toThrow(/Choose a role/);
    expect(() => validateRole({ id: "custom", label: "" })).toThrow(/custom role/);
    expect(roleKey({ id: "custom", label: "Program Host" })).toBe("custom:program host");
    expect([categoryForRole({ id: "candle_sponsor" }), categoryForRole({ id: "bridesmaid" }), categoryForRole({ id: "groom_parents" }), categoryForRole({ id: "custom", label: "x" })]).toEqual(["sponsors", "entourage", "family", "other"]);
  });

  it("roles are person ↔ role: many people per role (two Maids of Honor, two Best Men), one person with several roles; only the exact same assignment is refused", async () => {
    const ryan = await guest("Ryan Reyes", "sponsors");
    const shirley = await guest("Shirley Saragcon", "sponsors");
    const miguel = await guest("Miguel", "entourage", 1);
    const carlo = await guest("Carlo Jr.", "entourage", 1);
    const sanrah = await guest("Sanrah", "entourage", 1);
    const anna = await guest("Anna", "entourage", 1);
    ok(await assign(ryan, { id: "principal_sponsor" }));
    ok(await assign(shirley, { id: "principal_sponsor" }));
    for (const g of [miguel, carlo]) ok(await assign(g, { id: "best_man" }));
    for (const g of [sanrah, anna]) ok(await assign(g, { id: "maid_of_honor" }));
    ok(await assign(anna, { id: "bridesmaid" }));
    const dup = await assign(anna, { id: "bridesmaid" });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toBe("Anna is already Bridesmaid.");
    expect(doc(`guests/${anna}`)).toMatchObject({ roles: [{ id: "maid_of_honor" }, { id: "bridesmaid" }], roleKeys: ["maid_of_honor", "bridesmaid"] });
    ok(await assign(sanrah, { id: "custom", label: "Program host" }));
    const plan = rolesPlan([ryan, shirley, miguel, carlo, sanrah, anna].map((id) => ({ id, ...doc(`guests/${id}`) })));
    expect(plan.map((g) => [g.label, g.people.map((x) => x.name)])).toEqual([["Maid / Matron of Honor", ["Anna", "Sanrah"]], ["Best Man", ["Carlo Jr.", "Miguel"]], ["Principal Sponsors", ["Ryan Reyes", "Shirley Saragcon"]], ["Bridesmaids", ["Anna"]], ["Program host", ["Sanrah"]]]);
  });

  it("Change person moves a single role in one step; Change role swaps it on the same guest; Remove role keeps the guest, RSVP, seats and table", async () => {
    const tristan = await guest("Tristan", "entourage", 1);
    const rj = await guest("RJ", "entourage", 1);
    ok(await assign(tristan, { id: "best_man" }));
    ok(await api("guests", u.camille, { action: "setRsvp", guestId: tristan, rsvp: { status: "attending", confirmed: 1 } }));
    ok(await api("guests", u.camille, { action: "moveRole", fromGuestId: tristan, toGuestId: rj, role: { id: "best_man" } }));
    expect(doc(`guests/${tristan}`).roleKeys).toEqual([]);
    expect(doc(`guests/${rj}`).roleKeys).toEqual(["best_man"]);
    expect(doc(`guests/${rj}`).history.at(-1).label).toBe("Role added: Best Man (from Tristan)");
    ok(await api("guests", u.camille, { action: "moveRole", fromGuestId: rj, role: { id: "best_man" }, toRole: { id: "groomsman" } }));
    expect(doc(`guests/${rj}`).roles).toEqual([{ id: "groomsman" }]);
    ok(await assign(tristan, { id: "groomsman" }));
    ok(await api("guests", u.camille, { action: "unassignRole", guestId: tristan, role: { id: "groomsman" } }));
    expect(doc(`guests/${tristan}`)).toMatchObject({ name: "Tristan", rsvp: "attending", confirmed: 1, roleKeys: [] });
  });

  it("Staff can't assign; another wedding can't touch these guests; the invitation carries the role labels (for later wording)", async () => {
    const ryan = await guest("Ryan Reyes", "sponsors");
    expect((await assign(ryan, { id: "principal_sponsor" }, u.helper)).status).toBe(403);
    expect((await assign(ryan, { id: "principal_sponsor" }, u.other, W2)).status).toBe(404);
    ok(await assign(ryan, { id: "principal_sponsor" }));
    ok(await api("setup", u.camille, { action: "save", setup: { coupleNames: "Camille & Carlo", weddingDate: "2027-02-14" } }));
    const token = ok(await api("guests", u.camille, { action: "inviteLink", guestId: ryan })).path.split("/").pop();
    const res = await createInviteHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "view", token }) });
    expect(JSON.parse(res.body).invitation.guest.roles).toEqual(["Principal Sponsor"]);
  });

  it("Master Backup: a Wedding Roles sheet (role, key, guest, id, RSVP); the Guests sheet keeps the roles; the Tasks sheet keeps requirement details", async () => {
    const ryan = await guest("Ryan Reyes", "sponsors");
    ok(await assign(ryan, { id: "principal_sponsor" }));
    ok(await api("tasks", u.camille, { action: "create", task: { title: "Baptismal certificate", category: "Church Requirements", forWhom: "both", source: "San Jose Parish" } }), 201);
    const res = await createBackupHandler(deps())(asOperator(world, W));
    const bytes = Buffer.from(res.body, "base64");
    expect(readXlsx(bytes, { sheet: "Wedding Roles" }).rows).toEqual([["Role", "Role key", "Person", "Person key", "Party (guest)", "Guest id", "RSVP"], ["Principal Sponsors", "principal_sponsor", "Ryan Reyes", ryan, "Ryan Reyes", ryan, "awaiting"]]);
    const tasks = readXlsx(bytes, { sheet: "Tasks" }).rows;
    expect(tasks[0]).toEqual(expect.arrayContaining(["source", "forWhom", "parts"]));
  });
});

describe("requirement tasks: where to get it, Bride / Groom / Both", () => {
  it("source + forWhom stored; Both keeps each one's mark: first mark → In progress, both → Done, one undone → In progress", async () => {
    const id = ok(await api("tasks", u.camille, { action: "create", task: { title: "Baptismal certificate", category: "Church Requirements", forWhom: "both", source: "San Jose Parish", dueDate: "2026-11-01" } }), 201).taskId;
    expect(doc(`weddingTasks/${id}`)).toMatchObject({ forWhom: "both", source: "San Jose Parish", parts: { bride: false, groom: false }, status: "not_started" });
    ok(await api("tasks", u.camille, { action: "setPart", taskId: id, person: "bride", done: true }));
    expect(doc(`weddingTasks/${id}`)).toMatchObject({ parts: { bride: true, groom: false }, status: "in_progress" });
    ok(await api("tasks", u.camille, { action: "setPart", taskId: id, person: "groom", done: true }));
    expect(doc(`weddingTasks/${id}`)).toMatchObject({ parts: { bride: true, groom: true }, status: "completed", open: false });
    expect(doc("taskTotals/current")).toMatchObject({ completed: 1, open: 0 });
    ok(await api("tasks", u.camille, { action: "setPart", taskId: id, person: "groom", done: false }));
    expect(doc(`weddingTasks/${id}`)).toMatchObject({ parts: { bride: true, groom: false }, status: "in_progress", completedDate: null });
    expect(doc(`weddingTasks/${id}`).history.at(-1).label).toBe("Groom: not done · status Completed → In Progress");
    expect((await api("tasks", u.camille, { action: "create", task: { title: "X", forWhom: "everyone" } })).status).toBe(400);
    const plain = ok(await api("tasks", u.camille, { action: "create", task: { title: "Book florist" } }), 201).taskId;
    expect(doc(`weddingTasks/${plain}`)).toMatchObject({ forWhom: null, source: null });
    expect(doc(`weddingTasks/${plain}`).parts).toBeUndefined();
    expect((await api("tasks", u.camille, { action: "setPart", taskId: plain, person: "bride", done: true })).status).toBe(400);
    // Changing an ordinary task to Both starts the marks.
    ok(await api("tasks", u.camille, { action: "update", taskId: plain, changes: { forWhom: "both" } }));
    expect(doc(`weddingTasks/${plain}`).parts).toEqual({ bride: false, groom: false });
  });
});

describe("party members: named companions are real, reusable people", () => {
  const party = async () => {
    const g = await guest("Sanrah", "friends", 5);
    const ids = {};
    for (const n of ["Anna", "Bea", "Carla", "Diane"]) ids[n] = ok(await api("guests", u.camille, { action: "addMember", guestId: g, name: n }), 201).memberId;
    return { g, ids };
  };
  const people = () => peopleOf([...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/${W}/guests/`)).map(([k, v]) => ({ id: k.split("/").pop(), ...v })));

  it("5 invited with only the primary named: one person (anonymous seats are not people); adding 4 names makes 5 people in ONE guest record", async () => {
    const g = await guest("Sanrah", "friends", 5);
    expect(people().map((p) => p.name)).toEqual(["Sanrah"]);
    for (const n of ["Anna", "Bea", "Carla", "Diane"]) ok(await api("guests", u.camille, { action: "addMember", guestId: g, name: n }), 201);
    expect(people().map((p) => [p.name, p.key === g || p.key.startsWith(`${g}:m`), p.party])).toEqual([["Sanrah", true, "Sanrah"], ["Anna", true, "Sanrah"], ["Bea", true, "Sanrah"], ["Carla", true, "Sanrah"], ["Diane", true, "Sanrah"]]);
    expect([...world.db.docs.keys()].filter((k) => k.startsWith(`businesses/${W}/guests/`)).length).toBe(1); // no duplicate records
    expect((await api("guests", u.camille, { action: "addMember", guestId: g, name: "Ella" })).body.message).toMatch(/All 5 invited seats already have names/);
    expect((await api("guests", u.camille, { action: "addMember", guestId: g, name: "anna" })).status).toBe(400);
    expect((await api("guests", u.camille, { action: "update", guestId: g, changes: { partySize: 4 } })).body.message).toMatch(/5 named people/);
  });

  it("a companion takes a role (Anna → Bridesmaid) without copying the primary's; the role count is people, not seats", async () => {
    const { g, ids } = await party();
    ok(await assign(g, { id: "maid_of_honor" }));
    ok(await api("guests", u.camille, { action: "assignRole", guestId: g, memberId: ids.Anna, role: { id: "maid_of_honor" } }));
    ok(await api("guests", u.camille, { action: "assignRole", guestId: g, memberId: ids.Anna, role: { id: "bridesmaid" } }));
    const d = doc(`guests/${g}`);
    expect(d.roles).toEqual([{ id: "maid_of_honor" }]);
    expect(d.members.find((m) => m.name === "Anna").roles).toEqual([{ id: "maid_of_honor" }, { id: "bridesmaid" }]);
    expect(d.members.find((m) => m.name === "Bea").roles).toEqual([]);
    expect(d.roleKeys).toEqual(["maid_of_honor", "bridesmaid"]);
    const plan = rolesPlan([{ id: g, ...d }]);
    expect(plan.map((x) => [x.label, x.people.length, x.people.map((p) => p.name)])).toEqual([["Maid / Matron of Honor", 2, ["Anna", "Sanrah"]], ["Bridesmaids", 1, ["Anna"]]]);
    expect(peopleWithoutRole([{ id: g, ...d }]).map((p) => p.name)).toEqual(["Bea", "Carla", "Diane"]);
    const tan = await guest("Tan", "friends", 1);
    ok(await api("guests", u.camille, { action: "moveRole", fromGuestId: g, fromMemberId: ids.Anna, toGuestId: tan, role: { id: "bridesmaid" } }));
    expect(doc(`guests/${tan}`).roles).toEqual([{ id: "bridesmaid" }]);
    ok(await api("guests", u.camille, { action: "moveRole", fromGuestId: g, fromMemberId: ids.Anna, toGuestId: g, toMemberId: ids.Bea, role: { id: "maid_of_honor" } }));
    expect(doc(`guests/${g}`).members.map((m) => [m.name, m.roles.map((r) => r.id)])).toEqual([["Anna", []], ["Bea", ["maid_of_honor"]], ["Carla", []], ["Diane", []]]);
  });

  it("5 invited → 3 attending: RSVP by count with names optional; marks ≤ confirmed; Seating counts 3; a lower count clears marks", async () => {
    const { g, ids } = await party();
    ok(await api("guests", u.camille, { action: "setRsvp", guestId: g, rsvp: { status: "attending", confirmed: 3 } }));
    expect(doc(`guests/${g}`)).toMatchObject({ rsvp: "attending", confirmed: 3, partySize: 5 });
    for (const m of [null, ids.Anna, ids.Bea]) ok(await api("guests", u.camille, { action: "setAttending", guestId: g, memberId: m, attending: true }));
    expect((await api("guests", u.camille, { action: "setAttending", guestId: g, memberId: ids.Carla, attending: true })).body.message).toBe("Only 3 are attending. Raise the number attending first.");
    expect(attendingNames({ id: g, ...doc(`guests/${g}`) })).toEqual(["Sanrah", "Anna", "Bea"]);
    const t = ok(await api("guests", u.camille, { action: "createTable", table: { name: "Table 5", capacity: 8 } }), 201).tableId;
    ok(await api("guests", u.camille, { action: "seat", guestId: g, tableId: t }));
    const plan = seatingPlan([{ id: g, ...doc(`guests/${g}`) }], doc(`guestTotals/${SEATING_DOC_ID}`));
    expect(plan.tables[0].used).toBe(3);
    ok(await api("guests", u.camille, { action: "setRsvp", guestId: g, rsvp: { status: "attending", confirmed: 2 } }));
    expect(attendingNames({ id: g, ...doc(`guests/${g}`) })).toEqual([]);
    expect(doc(`guests/${g}`).confirmed).toBe(2);
  });

  it("renaming a companion keeps their role; removing one with a role warns first (member-linked), then works with force", async () => {
    const { g, ids } = await party();
    ok(await api("guests", u.camille, { action: "assignRole", guestId: g, memberId: ids.Anna, role: { id: "bridesmaid" } }));
    ok(await api("guests", u.camille, { action: "renameMember", guestId: g, memberId: ids.Anna, name: "Annabelle" }));
    expect(doc(`guests/${g}`).members.find((m) => m.id === ids.Anna)).toMatchObject({ name: "Annabelle", roles: [{ id: "bridesmaid" }] });
    const warn = await api("guests", u.camille, { action: "removeMember", guestId: g, memberId: ids.Anna });
    expect(warn.status).toBe(409);
    expect(warn.body.message).toBe("Annabelle is Bridesmaid. Remove them from this party anyway?");
    ok(await api("guests", u.camille, { action: "removeMember", guestId: g, memberId: ids.Bea }));
    ok(await api("guests", u.camille, { action: "removeMember", guestId: g, memberId: ids.Anna, force: true }));
    const d = doc(`guests/${g}`);
    expect(d.members.map((m) => m.name)).toEqual(["Carla", "Diane"]);
    expect(d.roleKeys).toEqual([]);
    expect(d.history.at(-1).label).toBe("Party member removed: Annabelle (was Bridesmaid)");
    expect((await api("guests", u.camille, { action: "removeMember", guestId: g, memberId: "primary" })).status).toBe(400);
  });

  it("the invitation stays party-based: one link, 5 seats; the guest answers 3 of 5, then 4 of 5", async () => {
    const { g } = await party();
    ok(await api("setup", u.camille, { action: "save", setup: { coupleNames: "Camille & Carlo", weddingDate: "2027-02-14", rsvpEnabled: true } }));
    const token = ok(await api("guests", u.camille, { action: "inviteLink", guestId: g })).path.split("/").pop();
    const invite = async (body) => JSON.parse((await createInviteHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) })).body);
    expect((await invite({ action: "view", token })).invitation.guest).toMatchObject({ name: "Sanrah", seats: 5 });
    await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 3 } });
    expect(doc(`guests/${g}`).history.at(-1).label).toBe("Guest responded: Attending · 3 of 5");
    await invite({ action: "respond", token, rsvp: { status: "attending", confirmed: 4 } });
    expect(doc(`guests/${g}`).history.at(-1).label).toBe("Guest changed RSVP: 3 of 5 → 4 of 5");
  });
});
