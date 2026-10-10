// Phase 18.6: the Owner manages the team from the Users page. Server rules:
// users.manage, no self-changes, the account owner protected, no Owner
// role, workspace roles only, the plan's user limit, audit, activation
// links (the person sets their own password).

import { describe, it, expect, beforeEach } from "vitest";
import { createMembersHandler } from "../../netlify/functions/members.js";
import { createActivateHandler } from "../../netlify/functions/activate.js";
import { createBusiness, addMember, ensureAuthUser, updateOverrides } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";

let world;
const B = "biz-a";
beforeEach(async () => {
  world = await buildWorld();
});
const deps = () => ({ getAdmin: async () => world, now: () => new Date("2026-10-16T04:00:00Z") });
async function members(uid, body = null, businessId = B) {
  const res = await createMembersHandler(deps())({ ...request({ uid, businessId, method: body ? "POST" : "GET" }), ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const memberDoc = (uid, b = B) => world.db.docs.get(`businesses/${b}/members/${uid}`);
const audits = (b = B) => [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/${b}/auditLog/`)).map(([, d]) => d.type);

describe("the team list", () => {
  it("owners and managers see it (users.view); staff don't; roles offered follow the workspace", async () => {
    const r = await members(world.uids.ownera);
    expect(r.status).toBe(200);
    expect(r.body.members.map((m) => m.name)).toEqual(expect.arrayContaining(["ownera", "managera", "staffa"]));
    expect(r.body.members[0]).toMatchObject({ name: "ownera", isAccountOwner: true });
    expect(r.body).toMatchObject({ roles: ["manager", "staff"], canManage: true, you: world.uids.ownera });
    expect(JSON.stringify(r.body)).not.toMatch(/permissions|linkHash/);
    expect((await members(world.uids.managera)).body.canManage).toBe(false);
    expect((await members(world.uids.staffa)).status).toBe(403);
  });
});

describe("Add member", () => {
  it("a new email: account with no password + one-time link; the person sets the password; audited", async () => {
    const r = await members(world.uids.ownera, { action: "invite", member: { name: "Ana Reyes", email: "Ana@Example.test", role: "staff" } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ login: "ana@example.test", existingAccount: false });
    expect(memberDoc(r.body.uid)).toMatchObject({ roleTemplate: "staff", status: "active", activation: { status: "pending" }, invitedBy: { uid: world.uids.ownera } });
    expect(audits()).toContain("member.added");
    const done = await createActivateHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "activate", token: r.body.activationToken, password: "mango-float-77" }) });
    expect(done.statusCode).toBe(200);
    expect((await members(world.uids.ownera)).body.members.find((m) => m.uid === r.body.uid)).toMatchObject({ activation: "active", status: "active" });
  });

  it("no email -> a login ID; an existing Luna account is added as is; refused: Owner role, household role, duplicates, the user limit", async () => {
    await updateOverrides({ ...world, businessId: B, set: { limits: { users: 8 } }, actor: "t", reason: "room for this test" });
    const id = await members(world.uids.ownera, { action: "invite", member: { name: "Lito Cruz", role: "staff" } });
    expect(id.body.login).toMatch(/^lito\.\d{4}$/);
    const ex = await ensureAuthUser({ auth: world.auth, email: "existing@t.test", name: "Existing" });
    const r = await members(world.uids.ownera, { action: "invite", member: { name: "Existing", email: "existing@t.test", role: "manager" } });
    expect(r.body).toMatchObject({ uid: ex.uid, existingAccount: true });
    expect(r.body.activationToken).toBeUndefined();
    expect((await members(world.uids.ownera, { action: "invite", member: { name: "X", email: "x@t.test", role: "owner" } })).body.error).toBe("invalid-role");
    expect((await members(world.uids.ownera, { action: "invite", member: { name: "X", email: "x@t.test", role: "household_staff" } })).body.error).toBe("invalid-role");
    expect((await members(world.uids.ownera, { action: "invite", member: { name: "Again", email: "existing@t.test", role: "staff" } })).body.error).toBe("already-member");
    // Growth plan user limit: keep adding until refused.
    let last;
    for (let i = 0; i < 20; i++) {
      last = await members(world.uids.ownera, { action: "invite", member: { name: `P${i}`, email: `p${i}@t.test`, role: "staff" } });
      if (last.status !== 201) break;
    }
    expect(last.status).toBe(403);
    expect(last.body.error).toBe("user-limit-reached");
  });

  it("a manager (no users.manage) can't add anyone", async () => {
    expect((await members(world.uids.managera, { action: "invite", member: { name: "X", email: "x@t.test", role: "staff" } })).status).toBe(403);
  });
});

describe("roles and access", () => {
  it("change role, remove access (signs them out), restore; never yourself, never the account owner", async () => {
    expect((await members(world.uids.ownera, { action: "setRole", uid: world.uids.staffa, role: "manager" })).status).toBe(200);
    expect(memberDoc(world.uids.staffa)).toMatchObject({ roleTemplate: "manager" });
    expect(memberDoc(world.uids.staffa).permissions["reports.view"]).toBe(true);
    expect((await members(world.uids.ownera, { action: "setAccess", uid: world.uids.staffa, enabled: false })).status).toBe(200);
    expect(memberDoc(world.uids.staffa).status).toBe("disabled");
    expect(world.auth.revoked).toContain(world.uids.staffa);
    expect((await members(world.uids.ownera, { action: "setAccess", uid: world.uids.staffa, enabled: true })).status).toBe(200);
    expect(audits()).toEqual(expect.arrayContaining(["member.updated", "member.deactivated", "member.reactivated"]));
    expect((await members(world.uids.ownera, { action: "setRole", uid: world.uids.ownera, role: "manager" })).body.error).toBe("not-yourself");
    expect((await members(world.uids.ownera, { action: "setAccess", uid: world.uids.ownera, enabled: false })).body.error).toBe("not-yourself");
    // A second owner-role member can't remove the account owner either.
    const co = await ensureAuthUser({ auth: world.auth, email: "co@t.test", name: "Co" });
    await addMember({ ...world, businessId: B, uid: co.uid, email: co.email, name: "Co", roleTemplate: "owner" });
    expect((await members(co.uid, { action: "setAccess", uid: world.uids.ownera, enabled: false })).body.error).toBe("owner-protected");
  });

  it("a new link only for an account not set up yet (or a login ID); email accounts reset their own password", async () => {
    const inv = (await members(world.uids.ownera, { action: "invite", member: { name: "Mia", email: "mia@t.test", role: "staff" } })).body;
    const link = await members(world.uids.ownera, { action: "newLink", uid: inv.uid });
    expect(link.status).toBe(200);
    expect(link.body.activationToken).not.toBe(inv.activationToken);
    expect((await members(world.uids.ownera, { action: "newLink", uid: world.uids.managera })).body.error).toBe("has-password");
  });

  it("another business's member can't be touched", async () => {
    const r = await members(world.uids.ownera, { action: "setAccess", uid: world.uids.ownerb, enabled: false });
    expect(r.status).toBe(404);
    expect(memberDoc(world.uids.ownerb, "biz-b").status).toBe("active");
  });
});

describe("workspaces", () => {
  it("a Baby tracker offers Manager only (the Distributor Staff role means nothing there)", async () => {
    await createBusiness({ ...world, name: "Baby", planId: "growth", workspaceTemplateId: "baby-expense", businessId: "biz-baby" });
    const o = await ensureAuthUser({ auth: world.auth, email: "mom@t.test", name: "Mom" });
    await addMember({ ...world, businessId: "biz-baby", uid: o.uid, email: o.email, name: "Mom", roleTemplate: "owner", isAccountOwner: true });
    expect((await members(o.uid, null, "biz-baby")).body.roles).toEqual(["manager"]);
    expect((await members(o.uid, { action: "invite", member: { name: "Yaya", role: "staff" } }, "biz-baby")).body.error).toBe("invalid-role");
  });
});
