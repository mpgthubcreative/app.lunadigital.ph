// Phase 17: Luna Super Admin operator API. Authorization (operators only,
// never a business role), one retry-safe provisioning workflow shared with
// the CLI, plan / override / subscription changes through the shared
// provisioning library (validated, recomputed, audited, revision-checked),
// members by role template only, tenant configuration, and the read models.

import { describe, it, expect, beforeEach } from "vitest";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { createSessionHandler } from "../../netlify/functions/session.js";
import { createProductsHandler } from "../../netlify/functions/products.js";
import { setOperator, provisionBusiness, createBusiness } from "../../netlify/functions/_lib/provisioning.js";
import { ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { validateEntitlementsSnapshot } from "../../shared/entitlements.js";

let world;
let ops;
beforeEach(async () => {
  world = await buildWorld();
  ops = {};
  for (const [key, status] of [["ops", "active"], ["opsoff", "disabled"]]) {
    const u = await ensureAuthUser({ auth: world.auth, email: `${key}@luna.test`, name: key });
    await setOperator({ ...world, email: u.email, status, reason: "test operator" });
    ops[key] = u.uid;
  }
  const odd = await ensureAuthUser({ auth: world.auth, email: "oddrole@luna.test", name: "odd" });
  world.db.seed(`operators/${odd.uid}`, { email: odd.email, role: "god", status: "active" });
  ops.odd = odd.uid;
});

const call = async (uid, body, token) => {
  const res = await createOperatorHandler({ getAdmin: async () => world })({ ...request(token !== undefined ? { token } : { uid }), httpMethod: "POST", body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const op = (body) => call(ops.ops, body);
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const docAt = (p) => world.db.docs.get(p);
const audits = (bid) => [...world.db.docs.entries()].filter(([p, d]) => p.startsWith("platformAudit/") && (!bid || d.businessId === bid)).map(([, d]) => d);
const NEW = { name: "ABC Test Trading", businessId: "abc-test-trading", workspaceTemplateId: "distributor", planId: "growth", ownerEmail: "Owner@ABC.test", ownerName: "Abe Owner", timezone: "Asia/Manila" };

describe("authorization: operators only (never a business role)", () => {
  it("no token 401; a business Owner, a disabled operator and an unknown operator role get 403; an operator gets the session", async () => {
    expect((await call(undefined, { action: "session" }, "")).status).toBe(401);
    for (const uid of [world.uids.ownera, world.uids.managera, world.uids.staffa, ops.opsoff, ops.odd]) {
      const r = await call(uid, { action: "listBusinesses" });
      expect(r.status, uid).toBe(403);
      expect(r.body.error).toBe("not-operator");
    }
    const s = ok(await op({ action: "session" }));
    expect(s.operator).toMatchObject({ email: "ops@luna.test", role: "superadmin" });
    expect(s.workspaces.map((w) => w.id).sort()).toEqual(["baby-expense", "bridal-expense", "distributor", "household-payroll"]);
  });

  it("validation happens only after the operator check (a non-operator learns nothing); unknown actions / fields refused", async () => {
    expect((await call(world.uids.ownera, { action: "nope" })).status).toBe(403);
    expect((await op({ action: "nope" })).status).toBe(400);
    expect((await op({ action: "changePlan", businessId: "biz-a", planId: "pro", reason: "x y z", entitlements: { modules: {} } })).status).toBe(400);
    expect((await op({ action: "addMember", businessId: "biz-a", email: "x@y.z", name: "x", roleTemplate: "staff", permissions: ["users.manage"] })).status).toBe(400);
  });
});

describe("create business: one retry-safe workflow", () => {
  it("creates the business at the workspace's current version, the owner's account and membership, default config and ONE audit", async () => {
    const r = ok(await op({ action: "createBusiness", business: NEW }));
    expect(r).toMatchObject({ businessId: "abc-test-trading", created: true, ownerCreated: true });
    const b = docAt("businesses/abc-test-trading");
    expect(b).toMatchObject({ name: "ABC Test Trading", nameLower: "abc test trading", workspaceTemplateId: "distributor", subscription: { planId: "growth", status: "active" }, timezone: "Asia/Manila", adminRevision: 0 });
    expect(validateEntitlementsSnapshot(b.entitlements, "growth", "distributor").ok).toBe(true);
    expect(b.entitlements.workspaceTemplateVersion).toBe(5);
    const member = docAt(`businesses/abc-test-trading/members/${r.ownerUid}`);
    expect(member).toMatchObject({ email: "owner@abc.test", roleTemplate: "owner", isAccountOwner: true, status: "active" });
    expect(member.permissions["users.manage"]).toBe(true);
    expect(docAt("businesses/abc-test-trading/settings/tenantConfig")).toMatchObject({ version: 1 });
    expect(docAt("provisioning/abc-test-trading")).toMatchObject({ status: "complete", ownerUid: r.ownerUid });
    expect(audits("abc-test-trading").filter((a) => a.type === "business.created")).toHaveLength(1);
  });

  it("double click / network retry: the same request returns the same business, no duplicate membership or audit", async () => {
    ok(await op({ action: "createBusiness", business: NEW }));
    const again = ok(await op({ action: "createBusiness", business: NEW }));
    expect(again).toMatchObject({ businessId: "abc-test-trading", created: false, alreadyProvisioned: true });
    expect([...world.db.docs.keys()].filter((k) => k.startsWith("businesses/abc-test-trading/members/"))).toHaveLength(1);
    expect(audits("abc-test-trading").filter((a) => a.type === "business.created")).toHaveLength(1);
  });

  it("a half-finished attempt resumes on retry (e.g. it stopped before the membership)", async () => {
    world.db.seed("provisioning/abc-test-trading", { request: { name: NEW.name, workspaceTemplateId: "distributor", planId: "growth", ownerEmail: "owner@abc.test", timezone: "Asia/Manila" }, status: "started" });
    await createBusiness({ ...world, name: NEW.name, planId: "growth", workspaceTemplateId: "distributor", businessId: "abc-test-trading" });
    const r = ok(await op({ action: "createBusiness", business: NEW }));
    expect(r.created).toBe(true);
    expect(docAt(`businesses/abc-test-trading/members/${r.ownerUid}`).isAccountOwner).toBe(true);
    expect(docAt("provisioning/abc-test-trading").status).toBe("complete");
  });

  it("the same id for a different business, or an id already used outside the console, is refused (409); nothing is overwritten", async () => {
    ok(await op({ action: "createBusiness", business: NEW }));
    expect((await op({ action: "createBusiness", business: { ...NEW, planId: "pro" } })).body.error).toBe("business-exists");
    expect((await op({ action: "createBusiness", business: { ...NEW, businessId: "biz-a" } })).body.error).toBe("business-exists");
    expect(docAt("businesses/biz-a").name).toBe("Biz A");
  });

  it("an existing Luna account becomes the owner (no second account); the CLI's provisionBusiness converges on the same records", async () => {
    const r = ok(await op({ action: "createBusiness", business: { ...NEW, ownerEmail: "ownerb@t.test" } }));
    expect(r.ownerUid).toBe(world.uids.ownerb);
    expect(r.ownerCreated).toBe(false);
    const cli = await provisionBusiness({ ...world, request: { ...NEW, ownerEmail: "ownerb@t.test" }, actor: "cli" });
    expect(cli).toMatchObject({ businessId: "abc-test-trading", alreadyProvisioned: true });
  });

  it("only live workspaces at their current version; never a typed id, a bad slug, an unknown plan or timezone", async () => {
    for (const bad of [{ workspaceTemplateId: "retail" }, { businessId: "ABC Trading!" }, { planId: "platinum" }, { timezone: "Mars/Olympus" }, { ownerEmail: "nope" }, { workspaceTemplateVersion: 1 }]) expect((await op({ action: "createBusiness", business: { ...NEW, ...bad } })).status, JSON.stringify(bad)).toBe(400);
  });
});

describe("plan, overrides, subscription: through the shared provisioning library", () => {
  beforeEach(async () => {
    ok(await op({ action: "createBusiness", business: NEW }));
  });
  const B = "abc-test-trading";
  const detail = async () => ok(await op({ action: "business", businessId: B }));

  it("Growth -> Starter: recomputed, valid, audited before -> after; user limit warning; nothing deleted", async () => {
    world.db.seed(`businesses/${B}/customers/c1`, { name: "Keep me" });
    const r = ok(await op({ action: "changePlan", businessId: B, planId: "starter", reason: "Client downgraded", expectedRevision: 0 }));
    expect(r).toMatchObject({ planId: "starter", adminRevision: 1 });
    const b = docAt(`businesses/${B}`);
    expect(validateEntitlementsSnapshot(b.entitlements, "starter", "distributor").ok).toBe(true);
    expect(b.entitlements.limits.users).toBe(2);
    const a = audits(B).find((x) => x.type === "entitlements.plan-assigned");
    expect(a).toMatchObject({ actor: "ops@luna.test", reason: "Client downgraded", before: { planId: "growth" }, after: { planId: "starter" } });
    expect(docAt(`businesses/${B}/customers/c1`)).toBeTruthy();
    expect((await op({ action: "changePlan", businessId: B, planId: "pro", reason: "x" })).body.error).toBe("reason-required");
  });

  it("a stale revision is refused (409): two operators can't silently overwrite each other", async () => {
    ok(await op({ action: "changePlan", businessId: B, planId: "pro", reason: "Upgrade", expectedRevision: 0 }));
    const r = await op({ action: "setModuleOverride", businessId: B, moduleId: "imports", choice: "disabled", reason: "Pause imports", expectedRevision: 0 });
    expect(r).toMatchObject({ status: 409, body: { error: "stale" } });
    expect(docAt(`businesses/${B}`).moduleOverrides).toEqual({});
  });

  it("overrides: Disabled / Enabled / Default inside the template; the module table explains template, plan, override, effective", async () => {
    ok(await op({ action: "setModuleOverride", businessId: B, moduleId: "imports", choice: "disabled", reason: "Pause imports", expectedRevision: 0 }));
    let d = await detail();
    expect(d.modules.find((m) => m.id === "imports")).toMatchObject({ template: true, plan: true, override: false, effective: false, editable: true });
    expect(docAt(`businesses/${B}`).entitlements.modules.imports).toBe(false);
    ok(await op({ action: "setModuleOverride", businessId: B, moduleId: "imports", choice: "default", reason: "Resume imports", expectedRevision: 1 }));
    d = await detail();
    expect(d.modules.find((m) => m.id === "imports")).toMatchObject({ override: null, effective: true });
    expect(d.modules.find((m) => m.id === "payroll")).toMatchObject({ template: false, effective: false, editable: false });
  });

  it("impossible overrides are refused: another workspace's module (payroll in a Distributor), core, unbuilt or unknown modules", async () => {
    for (const moduleId of ["payroll", "guests", "budget", "users", "suppliers", "nope"]) {
      const r = await op({ action: "setModuleOverride", businessId: B, moduleId, choice: "enabled", reason: "Try it" });
      expect(r.status, moduleId).toBe(400);
      expect(r.body.error).toBe("not-overridable");
    }
    expect(docAt(`businesses/${B}`).entitlements.modules.payroll).toBe(false);
  });

  it("suspend (reason) -> tenant writes refused, reads allowed; reactivate restores; cancel keeps data; all audited", async () => {
    const owner = docAt("provisioning/abc-test-trading").ownerUid;
    const addProduct = () => createProductsHandler({ getAdmin: async () => world })({ ...request({ uid: owner, businessId: B, method: "POST" }), body: JSON.stringify({ action: "create", product: { sku: `S${Math.random().toString(36).slice(2, 7)}`, name: "x", unit: "pcs", sellingPrice: 100, reorderLevel: 0 } }) });
    expect((await addProduct()).statusCode).toBe(201);
    expect((await op({ action: "setStatus", businessId: B, status: "suspended" })).body.error).toBe("reason-required");
    ok(await op({ action: "setStatus", businessId: B, status: "suspended", reason: "Payment overdue 60 days" }));
    expect((await addProduct()).statusCode).toBe(403);
    const s = await createSessionHandler({ getAdmin: async () => world })({ ...request({ uid: owner, businessId: B }), httpMethod: "GET" });
    expect(JSON.parse(s.body).subscription).toMatchObject({ status: "suspended", access: { canRead: true, canWrite: false } });
    ok(await op({ action: "setStatus", businessId: B, status: "active", reason: "Paid" }));
    expect((await addProduct()).statusCode).toBe(201);
    ok(await op({ action: "setStatus", businessId: B, status: "cancelled", reason: "Client left" }));
    expect([...world.db.docs.keys()].some((k) => k.startsWith(`businesses/${B}/products/`))).toBe(true);
    expect(audits(B).filter((a) => a.type === "subscription.status-changed").map((a) => `${a.before.status}->${a.after.status}`)).toEqual(["active->suspended", "suspended->active", "active->cancelled"]);
    expect((await op({ action: "setStatus", businessId: B, status: "deleted", reason: "x y z" })).status).toBe(400);
  });
});

describe("members: role templates only", () => {
  beforeEach(async () => {
    ok(await op({ action: "createBusiness", business: NEW }));
  });
  const B = "abc-test-trading";
  it("add a Manager (new account), change role, deactivate / reactivate (reason); the owner is protected; audited", async () => {
    const r = ok(await op({ action: "addMember", businessId: B, email: "mgr@abc.test", name: "Mia", roleTemplate: "manager" }));
    expect(r.accountCreated).toBe(true);
    expect(docAt(`businesses/${B}/members/${r.uid}`)).toMatchObject({ roleTemplate: "manager", status: "active", isAccountOwner: false });
    ok(await op({ action: "addMember", businessId: B, email: "mgr@abc.test", name: "Mia", roleTemplate: "staff" }));
    expect(docAt(`businesses/${B}/members/${r.uid}`).permissions["users.manage"]).toBeUndefined();
    ok(await op({ action: "setMemberStatus", businessId: B, uid: r.uid, status: "disabled", reason: "Left the company" }));
    expect(docAt(`businesses/${B}/members/${r.uid}`).status).toBe("disabled");
    const owner = docAt("provisioning/abc-test-trading").ownerUid;
    expect((await op({ action: "setMemberStatus", businessId: B, uid: owner, status: "disabled", reason: "try" })).body.error).toBe("owner-protected");
    expect((await op({ action: "addMember", businessId: B, email: "owner@abc.test", name: "Abe", roleTemplate: "staff" })).body.error).toBe("owner-protected");
    expect((await op({ action: "addMember", businessId: B, email: "x@abc.test", name: "X", roleTemplate: "god" })).status).toBe(400);
    expect(audits(B).map((a) => a.type)).toEqual(expect.arrayContaining(["member.added", "member.updated", "member.deactivated"]));
  });

  it("a setup link for a member with no password yet (no email infrastructure)", async () => {
    const owner = docAt("provisioning/abc-test-trading").ownerUid;
    expect(ok(await op({ action: "setupLink", businessId: B, uid: owner })).link).toMatch(/^https:/);
  });
});

describe("tenant configuration (controlled, fail-safe)", () => {
  beforeEach(async () => {
    ok(await op({ action: "createBusiness", business: NEW }));
  });
  const B = "abc-test-trading";
  it("Distributor: Customer -> Dealer relabels the app's navigation; only listed options; other workspaces have no such term", async () => {
    const owner = docAt("provisioning/abc-test-trading").ownerUid;
    const session = async () => JSON.parse((await createSessionHandler({ getAdmin: async () => world })({ ...request({ uid: owner, businessId: B }), httpMethod: "GET" })).body);
    expect((await session()).config.terminology.customer).toMatchObject({ choice: "customer", plural: "Customers" });
    ok(await op({ action: "setTerminology", businessId: B, terminology: { customer: "dealer" } }));
    expect((await session()).config.terminology.customer).toMatchObject({ choice: "dealer", plural: "Dealers" });
    expect((await op({ action: "setTerminology", businessId: B, terminology: { customer: "<b>x</b>" } })).status).toBe(400);
    expect((await op({ action: "setTerminology", businessId: B, terminology: { guest: "dealer" } })).status).toBe(400);
    expect(audits(B).some((a) => a.type === "tenant-config.updated")).toBe(true);
  });

  it("general settings: display name and timezone (validated, revisioned, audited); a missing config document reads as defaults", async () => {
    ok(await op({ action: "updateGeneral", businessId: B, changes: { name: "ABC Trading Corp", timezone: "Asia/Singapore" }, expectedRevision: 0 }));
    expect(docAt(`businesses/${B}`)).toMatchObject({ name: "ABC Trading Corp", nameLower: "abc trading corp", timezone: "Asia/Singapore", adminRevision: 1 });
    expect((await op({ action: "updateGeneral", businessId: B, changes: { timezone: "Nowhere/Land" } })).status).toBe(400);
    expect((await op({ action: "updateGeneral", businessId: B, changes: { workspaceTemplateId: "household-payroll" } })).status).toBe(400);
    world.db.docs.delete(`businesses/${B}/settings/tenantConfig`);
    expect(ok(await op({ action: "business", businessId: B })).config.terminology.customer.choice).toBe("customer");
  });
});

describe("read models", () => {
  it("overview counts; businesses filtered, searched (id or name prefix) and paginated (25 per page); detail; plans; audit", async () => {
    for (let i = 0; i < 27; i++) await createBusiness({ ...world, name: `Bulk ${i}`, planId: "starter", workspaceTemplateId: "household-payroll", businessId: `bulk-${String(i).padStart(2, "0")}` });
    const o = ok(await op({ action: "overview" })).overview;
    expect(o.total).toBe(31);
    expect(o.byWorkspace["household-payroll"]).toBe(27);
    expect(o.byStatus).toMatchObject({ active: 29, suspended: 1, cancelled: 1, past_due: 0 });
    const p1 = ok(await op({ action: "listBusinesses", filters: { workspaceTemplateId: "household-payroll" } }));
    expect(p1.rows).toHaveLength(25);
    const p2 = ok(await op({ action: "listBusinesses", filters: { workspaceTemplateId: "household-payroll" }, after: p1.next }));
    expect(p2.rows).toHaveLength(2);
    expect(p2.next).toBeNull();
    expect(ok(await op({ action: "listBusinesses", filters: { status: "suspended" } })).rows.map((r) => r.id)).toEqual(["biz-s"]);
    // name prefix "bulk 1" = "Bulk 1" and "Bulk 10".."Bulk 19"
    expect(ok(await op({ action: "listBusinesses", filters: { search: "bulk 1" } })).rows.map((r) => r.id)).toEqual(["bulk-01", ...Array.from({ length: 10 }, (_, i) => `bulk-${10 + i}`)]);
    expect(ok(await op({ action: "listBusinesses", filters: { search: "biz-" } })).rows.map((r) => r.id)).toEqual(["biz-a", "biz-b", "biz-s", "biz-x"]);
    const a = ok(await op({ action: "listBusinesses", filters: { search: "biz-a" } })).rows[0];
    expect(a).toMatchObject({ id: "biz-a", workspaceTemplateId: "distributor", planId: "growth", status: "active", owner: { email: "ownera@t.test" } });
    expect((await op({ action: "listBusinesses", filters: { status: "deleted" } })).status).toBe(400);
    expect((await op({ action: "listBusinesses", filters: { path: "x" } })).status).toBe(400);
    const d = ok(await op({ action: "business", businessId: "biz-a" }));
    expect(d.business).toMatchObject({ id: "biz-a", workspaceTemplateId: "distributor", entitlementsValid: true });
    expect(d.members.map((m) => m.email).sort()).toEqual(["disableda@t.test", "managera@t.test", "multi@t.test", "ownera@t.test", "staffa@t.test"]);
    expect((await op({ action: "business", businessId: "nope-nope" })).status).toBe(404);
    expect(ok(await op({ action: "plans" })).plans.map((p) => p.id)).toEqual(["starter", "growth", "pro"]);
    expect(ok(await op({ action: "audit" })).rows.length).toBeGreaterThan(0);
  });
});
