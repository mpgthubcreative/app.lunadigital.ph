// Reset Workspace Data (2026-10-21): the account owner empties THIS
// workspace's everyday records (typed RESET, audited). Never another
// business, never the workspace shell, members, settings, audit log,
// subscription / bills to Luna or sign-in accounts.

import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createResetDataHandler } from "../../netlify/functions/reset-data.js";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createSessionHandler } from "../../netlify/functions/session.js";
import { ensureAuthUser, createBusiness, addMember } from "../../netlify/functions/_lib/provisioning.js";
import { RESET_PLAN } from "../../shared/reset.js";
import { getWorkspaceTemplate } from "../../shared/workspaces.js";
import { getModule } from "../../shared/modules.js";

let world;
beforeEach(async () => {
  world = await buildWorld();
});

const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });
const reset = async (bid, uid, body) => parse(await createResetDataHandler({ getAdmin: async () => world })({ ...request({ uid, businessId: bid, method: "POST" }), body: JSON.stringify(body) }));
const docsUnder = (prefix) => [...world.db.docs.keys()].filter((k) => k.startsWith(prefix));
const OPERATIONAL = ["orders/o1", "orders/o2", "payments/p1", "products/sku1", "productCosts/sku1", "inventoryTransactions/t1", "customers/c1", "expenses/e1", "imports/i1", "imports/i1/rows/1", "metrics/2026-10-20", "counters/orders", "skuIndex/abc"];
const KEPT = ["settings/tenantConfig", "auditLog/a1", "usage/2026-10"];

function seed(bid) {
  for (const p of [...OPERATIONAL, ...KEPT]) world.db.docs.set(`businesses/${bid}/${p}`, { seeded: bid });
  world.storage.files.set(`tenants/${bid}/products/sku1.jpg`, { data: Buffer.from("x".repeat(100)), contentType: "image/jpeg", metadata: {} });
  world.storage.files.set(`tenants/${bid}/payments/proofs/o1/p1.jpg`, { data: Buffer.from("y".repeat(50)), contentType: "image/jpeg", metadata: {} });
}

describe("Reset Workspace Data", () => {
  it("only the account owner, only with RESET typed; never while suspended", async () => {
    seed("biz-a");
    for (const key of ["managera", "staffa"]) expect((await reset("biz-a", world.uids[key], { action: "reset", confirm: "RESET" })).status, key).toBe(403);
    expect((await reset("biz-a", world.uids.ownera, { action: "reset", confirm: "reset" })).body.error).toBe("confirm-mismatch");
    expect((await reset("biz-a", world.uids.ownera, { action: "reset" })).status).toBe(400);
    expect((await reset("biz-s", world.uids.owners, { action: "reset", confirm: "RESET" })).status).toBe(403);
    // Another business's owner can't name this one.
    expect((await reset("biz-a", world.uids.ownerb, { action: "reset", confirm: "RESET" })).status).toBe(403);
    expect(docsUnder("businesses/biz-a/orders/")).toHaveLength(2);
  });

  it("removes this workspace's records and files; keeps the shell, members, settings, audit, subscription; the other business is untouched", async () => {
    seed("biz-a");
    seed("biz-b");
    const before = structuredClone(world.db.docs.get("businesses/biz-a"));
    const plan = (await reset("biz-a", world.uids.ownera, { action: "plan" })).body;
    expect(plan.removes).toEqual(expect.arrayContaining(["Orders and their payments", "Customers"]));
    expect(plan.keeps.join(" ")).toMatch(/Members and their sign-in accounts/);
    const r = await reset("biz-a", world.uids.ownera, { action: "reset", confirm: "RESET" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ reset: true, files: 2 });
    expect(r.body.counts).toMatchObject({ orders: 2, payments: 1, products: 1, customers: 1, imports: 2 });
    for (const p of OPERATIONAL) expect(world.db.docs.has(`businesses/biz-a/${p}`), p).toBe(false);
    for (const p of KEPT) expect(world.db.docs.has(`businesses/biz-a/${p}`), p).toBe(true);
    expect([...world.storage.files.keys()].filter((k) => k.startsWith("tenants/biz-a/"))).toEqual([]);
    // The workspace shell: same name, product, subscription, entitlements.
    const after = world.db.docs.get("businesses/biz-a");
    expect(after).toMatchObject({ name: before.name, workspaceTemplateId: before.workspaceTemplateId, subscription: before.subscription, entitlements: before.entitlements });
    expect(after.lastResetBy).toBe("ownera@t.test");
    // Members (and their sign-in accounts) stay.
    for (const key of ["ownera", "managera", "staffa"]) {
      expect(world.db.docs.has(`businesses/biz-a/members/${world.uids[key]}`), key).toBe(true);
      expect(await world.auth.getUser(world.uids[key])).toBeTruthy();
    }
    // Audited for the business and for Luna.
    const audit = [...world.db.docs.entries()].filter(([, v]) => v?.type === "data.reset");
    expect(audit.map(([k]) => k.split("/")[0])).toEqual(expect.arrayContaining(["businesses", "platformAudit"]));
    expect(audit[0][1]).toMatchObject({ businessId: "biz-a", actor: "ownera@t.test", files: 2 });
    // Biz B: every record and file still there.
    for (const p of [...OPERATIONAL, ...KEPT]) expect(world.db.docs.get(`businesses/biz-b/${p}`), p).toEqual({ seeded: "biz-b" });
    expect([...world.storage.files.keys()].filter((k) => k.startsWith("tenants/biz-b/"))).toHaveLength(2);
    // The owner signs in to the same (now empty) workspace.
    const s = parse(await createSessionHandler({ getAdmin: async () => world })({ ...request({ uid: world.uids.ownera, businessId: "biz-a" }), httpMethod: "GET" }));
    expect(s.status).toBe(200);
    expect(s.body.business.id).toBe("biz-a");
  });

  it("Household: staff records and their kasambahay logins go; the helper's sign-in account and the owner stay", async () => {
    await createBusiness({ ...world, name: "Santos Home", planId: "household-basic", workspaceTemplateId: "household-payroll", businessId: "home-r" });
    const o = await ensureAuthUser({ auth: world.auth, email: "owner@home-r.test", name: "Owner" });
    await addMember({ ...world, businessId: "home-r", uid: o.uid, email: o.email, name: "Owner", roleTemplate: "owner", isAccountOwner: true });
    const H = (body) => createHouseholdStaffHandler({ getAdmin: async () => world })({ ...request({ uid: o.uid, businessId: "home-r", method: "POST" }), body: JSON.stringify(body) });
    const staffId = JSON.parse((await H({ action: "create", staff: { name: "Loriza Ibanez", dailyWage: 60000, payCycle: "semi_monthly" } })).body).staffId;
    expect((await H({ action: "createLogin", staffId })).statusCode).toBe(201);
    const login = [...world.db.docs.entries()].find(([k, v]) => k.startsWith("businesses/home-r/members/") && v?.staffId === staffId);
    expect(login).toBeTruthy();
    const loginUid = login[0].split("/")[3];
    const r = await reset("home-r", o.uid, { action: "reset", confirm: "RESET" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.staffLoginsRemoved).toBe(1);
    expect(docsUnder("businesses/home-r/householdStaff/")).toEqual([]);
    expect(world.db.docs.has(`businesses/home-r/members/${loginUid}`)).toBe(false);
    expect(world.db.docs.has(`businesses/home-r/members/${o.uid}`)).toBe(true);
    expect(await world.auth.getUser(loginUid)).toBeTruthy();
  });

  it("the documented plan covers every everyday collection each workspace's modules use", () => {
    const keep = new Set(["members", "settings", "inbox", "inboxState"]);
    for (const [ws, plan] of Object.entries(RESET_PLAN)) {
      const t = getWorkspaceTemplate(ws);
      expect(t, ws).toBeTruthy();
      const used = new Set(t.modules.flatMap((id) => Object.keys(getModule(id)?.collections || {})).filter((c) => !keep.has(c)));
      for (const c of used) expect(plan.removes, `${ws}: ${c}`).toContain(c);
      expect(plan.removes).not.toEqual(expect.arrayContaining(["members", "settings", "auditLog", "usage", "weddingSetup", "invitationDesign"]));
    }
  });
});
