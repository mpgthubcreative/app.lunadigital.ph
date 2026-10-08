// Phase 8.5 on the server: a non-Distributor workspace can't reach any
// Distributor API however the request is crafted; stale / unknown /
// mismatched workspace snapshots fail closed; template assignment and
// change are confirmed, reasoned, recomputed and audited; the pre-8.5
// migration path works.

import { describe, it, expect, beforeEach } from "vitest";
import { requireTenant } from "../../netlify/functions/_lib/tenant.js";
import { createOrdersHandler } from "../../netlify/functions/orders.js";
import { createProductsHandler } from "../../netlify/functions/products.js";
import { createInventoryHandler } from "../../netlify/functions/inventory.js";
import { createPaymentsHandler } from "../../netlify/functions/payments.js";
import { createReportsHandler } from "../../netlify/functions/reports.js";
import { createSessionHandler } from "../../netlify/functions/session.js";
import { createBusiness, addMember, ensureAuthUser, assignWorkspaceTemplate, refreshEntitlements, updateOverrides, assignPlan, describeEntitlements } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";

let world;
const uid = {};
const op = { actor: "ops@luna", reason: "unit test" };
const biz = (id) => world.db.docs.get(`businesses/${id}`);
const audits = (bid) => [...world.db.docs.entries()].filter(([p]) => p.startsWith(`businesses/${bid}/auditLog/`)).map(([, d]) => d);

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Reyes Wedding", planId: "pro", workspaceTemplateId: "bridal-expense", businessId: "biz-w" });
  for (const role of ["owner", "manager", "staff"]) {
    const u = await ensureAuthUser({ auth: world.auth, email: `${role}w@t.test`, name: `${role} W` });
    uid[role] = u.uid;
    await addMember({ ...world, businessId: "biz-w", uid: u.uid, email: u.email, name: `${role} W`, roleTemplate: role, isAccountOwner: role === "owner" });
  }
});

const post = async (factory, who, body, businessId = "biz-w") => {
  const res = await factory({ getAdmin: async () => world })({ ...request({ uid: who, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const session = async (who, businessId) => {
  const res = await createSessionHandler({ getAdmin: async () => world })(request({ uid: who, businessId }));
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

describe("a bridal workspace can't reach Distributor APIs", () => {
  it("session: workspace identity, no Distributor modules on, Pro plan still Pro", async () => {
    const s = await session(uid.owner, "biz-w");
    expect(s.status).toBe(200);
    expect(s.body.workspace).toEqual({ templateId: "bridal-expense", templateVersion: 1, name: "Bridal / Wedding Management Tracker" });
    expect(s.body.plan).toEqual({ id: "pro", name: "Pro" });
    for (const m of ["orders", "payments", "inventory", "customers", "reports", "imports"]) expect(s.body.entitlements.modules[m], m).toBe(false);
    expect(s.body.entitlements.workspaceTemplateId).toBe("bridal-expense");
  });

  it("the owner holds orders.create etc. but every Distributor call is refused (403, no data)", async () => {
    const s = await session(uid.owner, "biz-w");
    expect(s.body.permissions["orders.create"]).toBe(true);
    const calls = [
      [createOrdersHandler, { action: "create", idempotencyKey: "ws-test-key-000000001", order: { customer: { name: "x" }, source: "phone", items: [] } }],
      [createOrdersHandler, { action: "fulfill", orderId: "aaaaaaaaaaaaaaaaaaaa" }],
      [createProductsHandler, { action: "create", product: { sku: "X", name: "x", unit: "pcs", sellingPrice: 1, reorderLevel: 0 } }],
      [createInventoryHandler, { action: "receipt", productId: "aaaaaaaaaaaaaaaaaaaa", quantity: 1000, unitCost: 1 }],
      [createPaymentsHandler, { action: "record", orderId: "aaaaaaaaaaaaaaaaaaaa", payment: { amount: 1, method: "cash" } }],
      [createPaymentsHandler, { action: "proof", paymentId: "aaaaaaaaaaaaaaaaaaaa" }],
    ];
    for (const who of [uid.owner, uid.manager, uid.staff]) {
      for (const [factory, body] of calls) {
        const r = await post(factory, who, body);
        expect(r.status, `${body.action}`).toBe(403);
        expect(r.body.error).toBe("forbidden");
      }
    }
    const reports = await createReportsHandler({ getAdmin: async () => world })(request({ uid: uid.owner, businessId: "biz-w" }));
    expect(reports.statusCode).toBe(403);
    expect([...world.db.docs.keys()].some((p) => p.startsWith("businesses/biz-w/orders/") || p.startsWith("businesses/biz-w/products/"))).toBe(false);
  });

  it("requireTenant names the reason server-side: module-disabled", async () => {
    await expect(requireTenant(request({ uid: uid.owner, businessId: "biz-w" }), { db: world.db, auth: world.auth, permission: "orders.view" })).rejects.toMatchObject({ statusCode: 403, reason: "module-disabled:orders" });
  });

  it("core modules still follow roles: owner/manager see Users, staff don't", async () => {
    const guard = (who) => requireTenant(request({ uid: who, businessId: "biz-w" }), { db: world.db, auth: world.auth, permission: "users.view" });
    await expect(guard(uid.owner)).resolves.toMatchObject({ businessId: "biz-w", workspace: { templateId: "bridal-expense" } });
    await expect(guard(uid.manager)).resolves.toBeTruthy();
    await expect(guard(uid.staff)).rejects.toMatchObject({ reason: "missing-permission:users.view" });
  });

  it("forging the stored snapshot to switch Orders on is still refused", async () => {
    biz("biz-w").entitlements.modules.orders = true;
    const r = await post(createOrdersHandler, uid.owner, { action: "fulfill", orderId: "aaaaaaaaaaaaaaaaaaaa" });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("business-misconfigured");
  });
});

describe("Distributor tenants are unchanged", () => {
  it("session reports the distributor workspace with its built modules (placeholders off)", async () => {
    const s = await session(world.uids.ownera, "biz-a");
    expect(s.body.workspace.templateId).toBe("distributor");
    for (const m of ["orders", "payments", "inventory", "customers", "expenses"]) expect(s.body.entitlements.modules[m], m).toBe(true);
    for (const m of ["reports", "imports"]) expect(s.body.entitlements.modules[m], m).toBe(false);
  });

  it("orders, products and payments endpoints are reachable as before", async () => {
    const r = await post(createProductsHandler, world.uids.ownera, { action: "create", product: { sku: "WS-1", name: "Wings", unit: "pcs", sellingPrice: 100, reorderLevel: 0 } }, "biz-a");
    expect(r.status).toBe(201);
    expect((await post(createPaymentsHandler, world.uids.staffa, { action: "proof", paymentId: "aaaaaaaaaaaaaaaaaaaa" }, "biz-a")).status).toBe(404);
  });
});

describe("stale, unknown or mismatched workspace snapshots fail closed (503)", () => {
  const blocked = async (mutate) => {
    mutate(biz("biz-w"));
    const s = await session(uid.owner, "biz-w");
    expect(s.status).toBe(503);
    expect(s.body.error).toBe("business-misconfigured");
  };
  it("template version changed (stale snapshot)", () => blocked((b) => (b.entitlements.workspaceTemplateVersion = 0)));
  it("business template changed without a recompute", () => blocked((b) => (b.workspaceTemplateId = "baby-expense")));
  it("unknown template", () => blocked((b) => (b.workspaceTemplateId = "florist")));
  it("malformed template", () => blocked((b) => (b.workspaceTemplateId = { id: "bridal-expense" })));
  it("missing template on an 8.5 snapshot", () => blocked((b) => delete b.workspaceTemplateId));
  it("snapshot without its workspace", () => blocked((b) => delete b.entitlements.workspaceTemplateId));
});

describe("operator tooling: assign / change template", () => {
  it("there is no default: createBusiness needs a registered template", async () => {
    await expect(createBusiness({ ...world, name: "X", planId: "growth" })).rejects.toMatchObject({ code: "unknown-template" });
    await expect(createBusiness({ ...world, name: "X", planId: "growth", workspaceTemplateId: "bridal" })).rejects.toMatchObject({ code: "unknown-template" });
  });

  it("changing a template needs explicit confirmation", async () => {
    await expect(assignWorkspaceTemplate({ ...world, businessId: "biz-a", templateId: "bridal-expense", ...op })).rejects.toMatchObject({ code: "template-change-unconfirmed" });
    expect(biz("biz-a").workspaceTemplateId).toBe("distributor");
  });

  it("needs a reason", async () => {
    await expect(assignWorkspaceTemplate({ ...world, businessId: "biz-a", templateId: "bridal-expense", allowChange: true, actor: "ops", reason: "" })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("a confirmed change recomputes and is audited (actor, time, reason, old → new); data is kept", async () => {
    await post(createProductsHandler, world.uids.ownera, { action: "create", product: { sku: "KEEP", name: "Keep", unit: "pcs", sellingPrice: 100, reorderLevel: 0 } }, "biz-a");
    const r = await assignWorkspaceTemplate({ ...world, businessId: "biz-a", templateId: "bridal-expense", allowChange: true, actor: "ops@luna", reason: "Client switched to wedding planning" });
    expect(r).toMatchObject({ workspaceTemplateId: "bridal-expense", previousWorkspaceTemplateId: "distributor" });
    expect(biz("biz-a")).toMatchObject({ workspaceTemplateId: "bridal-expense", entitlements: { schemaVersion: 2, workspaceTemplateId: "bridal-expense", workspaceTemplateVersion: 1, modules: { orders: false, inventory: false } } });
    const [entry] = audits("biz-a").filter((a) => a.type === "workspace.template-changed");
    expect(entry).toMatchObject({ summary: "Workspace template changed: distributor → bridal-expense", actor: "ops@luna", reason: "Client switched to wedding planning", before: { workspaceTemplateId: "distributor" }, after: { workspaceTemplateId: "bridal-expense" } });
    expect(entry.at).toBeTruthy();
    expect([...world.db.docs.entries()].filter(([p]) => p.startsWith("platformAudit/")).some(([, d]) => d.type === "workspace.template-changed")).toBe(true);
    expect([...world.db.docs.keys()].some((p) => p.startsWith("businesses/biz-a/products/"))).toBe(true); // nothing deleted
    expect((await post(createProductsHandler, world.uids.ownera, { action: "create", product: { sku: "NO", name: "No", unit: "pcs", sellingPrice: 1, reorderLevel: 0 } }, "biz-a")).status).toBe(403);
  });

  it("an override the new template doesn't allow is refused, not silently dropped", async () => {
    // A plan add-on for Payments on a Starter-like plan is fine in distributor...
    await updateOverrides({ ...world, businessId: "biz-a", set: { modules: { payments: true } }, ...op });
    // ...but baby-expense doesn't allow Payments, so the change is refused.
    await expect(assignWorkspaceTemplate({ ...world, businessId: "biz-a", templateId: "baby-expense", allowChange: true, ...op })).rejects.toMatchObject({ code: "invalid-input" });
    expect(biz("biz-a").workspaceTemplateId).toBe("distributor");
  });

  it("disable overrides still work inside a workspace; plan changes keep the template", async () => {
    await updateOverrides({ ...world, businessId: "biz-a", set: { modules: { inventory: false } }, ...op });
    expect(biz("biz-a").entitlements.modules.inventory).toBe(false);
    await assignPlan({ ...world, businessId: "biz-w", planId: "starter", ...op });
    expect(biz("biz-w")).toMatchObject({ workspaceTemplateId: "bridal-expense", subscription: { planId: "starter" }, entitlements: { planId: "starter", workspaceTemplateId: "bridal-expense", modules: { orders: false } } });
  });

  it("re-assigning the same template is a no-op recompute, not a change", async () => {
    await assignWorkspaceTemplate({ ...world, businessId: "biz-a", templateId: "distributor", ...op });
    expect(audits("biz-a").some((a) => a.type === "workspace.template-changed")).toBe(false);
  });
});

describe("migrating a pre-8.5 tenant", () => {
  // What a Phase 4-8 business looks like: schemaVersion 1, no workspace.
  const makeLegacy = (bid) => {
    const b = biz(bid);
    delete b.workspaceTemplateId;
    b.entitlements.schemaVersion = 1;
    delete b.entitlements.workspaceTemplateId;
    delete b.entitlements.workspaceTemplateVersion;
  };

  it("an unmigrated (legacy) tenant fails closed: there is no 'missing = distributor'", async () => {
    makeLegacy("biz-a");
    expect((await session(world.uids.ownera, "biz-a")).status).toBe(503);
  });

  it("other entitlement changes refuse until the template is assigned", async () => {
    makeLegacy("biz-a");
    await expect(refreshEntitlements({ ...world, businessId: "biz-a", ...op })).rejects.toMatchObject({ code: "no-template" });
    await expect(assignPlan({ ...world, businessId: "biz-a", planId: "pro", ...op })).rejects.toMatchObject({ code: "no-template" });
  });

  it("assigning distributor migrates it in one audited step, with the same modules", async () => {
    makeLegacy("biz-a");
    const before = structuredClone(biz("biz-a").entitlements.modules);
    await assignWorkspaceTemplate({ ...world, businessId: "biz-a", templateId: "distributor", actor: "migration", reason: "Phase 8.5 migration" });
    expect(biz("biz-a")).toMatchObject({ workspaceTemplateId: "distributor", entitlements: { schemaVersion: 2, workspaceTemplateId: "distributor", workspaceTemplateVersion: 3 } });
    expect(biz("biz-a").entitlements.modules).toEqual(before);
    expect(audits("biz-a").find((a) => a.type === "workspace.template-assigned")).toMatchObject({ summary: "Workspace template assigned: distributor", reason: "Phase 8.5 migration", before: { workspaceTemplateId: null } });
    expect((await describeEntitlements({ db: world.db, businessId: "biz-a" })).valid).toBe(true);
    expect((await session(world.uids.ownera, "biz-a")).status).toBe(200);
  });
});
