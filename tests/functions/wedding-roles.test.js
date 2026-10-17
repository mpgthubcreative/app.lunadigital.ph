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
import { buildWorld, request } from "../helpers/tenants.js";
import { validateRole, roleKey, rolesPlan, categoryForRole } from "../../shared/wedding-roles.js";
import { readXlsx } from "../../shared/xlsx.js";

const NOW = new Date("2026-10-16T04:00:00Z");
const W = "biz-wed";
const W2 = "biz-wed-2";
let world;
let u;

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Reyes-Prado Wedding", planId: "bridal-plus", workspaceTemplateId: "bridal-expense", businessId: W });
  await createBusiness({ ...world, name: "Cruz Wedding", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W2 });
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

  it("many people per role (sponsors); one person for a single role (Best Man) — a second is refused with a clear message", async () => {
    const ryan = await guest("Ryan Reyes", "sponsors");
    const shirley = await guest("Shirley Saragcon", "sponsors");
    const tristan = await guest("Tristan", "entourage", 1);
    const rj = await guest("RJ", "entourage", 1);
    ok(await assign(ryan, { id: "principal_sponsor" }));
    ok(await assign(shirley, { id: "principal_sponsor" }));
    ok(await assign(tristan, { id: "best_man" }));
    const taken = await assign(rj, { id: "best_man" });
    expect(taken.status).toBe(409);
    expect(taken.body.message).toBe("Best Man is already Tristan. Use ⋯ → Change person instead.");
    expect(doc(`guests/${ryan}`)).toMatchObject({ roles: [{ id: "principal_sponsor" }], roleKeys: ["principal_sponsor"] });
    expect(doc(`guests/${ryan}`).history.at(-1).label).toBe("Role added: Principal Sponsor");
    // Same role again: unchanged; a custom role too.
    expect(ok(await assign(ryan, { id: "principal_sponsor" })).unchanged).toBe(true);
    ok(await assign(rj, { id: "custom", label: "Program host" }));
    const plan = rolesPlan([ryan, shirley, tristan, rj].map((id) => ({ id, ...doc(`guests/${id}`) })));
    expect(plan.map((g) => [g.label, g.guests.map((x) => x.name)])).toEqual([["Best Man", ["Tristan"]], ["Principal Sponsors", ["Ryan Reyes", "Shirley Saragcon"]], ["Program host", ["RJ"]]]);
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
    const res = await createBackupHandler(deps())({ ...request({ uid: u.camille, businessId: W, method: "POST" }), body: "{}" });
    const bytes = Buffer.from(res.body, "base64");
    expect(readXlsx(bytes, { sheet: "Wedding Roles" }).rows).toEqual([["Role", "Role key", "Guest", "Guest id", "RSVP", "Seats invited", "Attending"], ["Principal Sponsors", "principal_sponsor", "Ryan Reyes", ryan, "awaiting", "2", "0"]]);
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
