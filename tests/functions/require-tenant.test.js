// Phase 4 server authorization: requireTenant() = active membership AND
// module entitlement AND exact permission (+ subscription policy), and the
// guard-only GET /api/reports endpoint built on it.

import { describe, it, expect, beforeEach } from "vitest";
import { requireTenant } from "../../netlify/functions/_lib/tenant.js";
import { createReportsHandler } from "../../netlify/functions/reports.js";
import { createSessionHandler } from "../../netlify/functions/session.js";
import { addMember, ensureAuthUser, updateOverrides } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";

let world;
let reportStaff;

beforeEach(async () => {
  world = await buildWorld();
  // A Business A staff member who has been granted reports.view.
  const user = await ensureAuthUser({ auth: world.auth, email: "reportstaff@t.test", name: "Report Staff" });
  reportStaff = user.uid;
  // Growth allows 5 users; A has 4 active (owner, manager, staff, multi).
  await addMember({ ...world, businessId: "biz-a", uid: reportStaff, email: user.email, name: "Report Staff", roleTemplate: "staff", permissionOverrides: { grant: ["reports.view"] } });
});

const guard = (uid, businessId, opts, extraHeaders = {}) => {
  const event = request({ uid, businessId });
  Object.assign(event.headers, extraHeaders);
  return requireTenant(event, { db: world.db, auth: world.auth, ...opts });
};
const businessDoc = (id) => world.db.docs.get(`businesses/${id}`);

async function callReports(uid, businessId) {
  const res = await createReportsHandler({ getAdmin: async () => world })(request({ uid, businessId }));
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

// Reports is unbuilt since the Phase 8.5 cleanup, so the Phase 4 scenario
// now uses Inventory, a built module Staff can view.
const disableInventoryForA = () => updateOverrides({ ...world, businessId: "biz-a", set: { modules: { inventory: false } }, actor: "test", reason: "test: inventory off" });

describe("THE scenario: staff with inventory.view, Inventory disabled for the business", () => {
  it("is allowed while Inventory is enabled", async () => {
    await expect(guard(world.uids.staffa, "biz-a", { permission: "inventory.view" })).resolves.toMatchObject({ businessId: "biz-a" });
  });

  it("is DENIED by requireTenant once Inventory is off", async () => {
    await disableInventoryForA();
    await expect(guard(world.uids.staffa, "biz-a", { permission: "inventory.view" })).rejects.toMatchObject({ statusCode: 403, code: "forbidden", reason: "module-disabled:inventory" });
  });

  it("the account owner is denied too: permissions don't outrank the package", async () => {
    await disableInventoryForA();
    await expect(guard(world.uids.ownera, "biz-a", { permission: "inventory.view" })).rejects.toMatchObject({ reason: "module-disabled:inventory" });
  });

  it("the session tells the UI Inventory is off", async () => {
    await disableInventoryForA();
    const res = await createSessionHandler({ getAdmin: async () => world })(request({ uid: world.uids.staffa }));
    const body = JSON.parse(res.body);
    expect(body.permissions["inventory.view"]).toBe(true);
    expect(body.entitlements.modules.inventory).toBe(false);
  });
});

describe("Reports (built in Phase 11): reports.view + the module", () => {
  it("staff granted reports.view and the owner pass requireTenant; plain staff don't", async () => {
    await expect(guard(reportStaff, "biz-a", { permission: "reports.view" })).resolves.toBeTruthy();
    await expect(guard(world.uids.ownera, "biz-a", { permission: "reports.view" })).resolves.toBeTruthy();
    await expect(guard(world.uids.staffa, "biz-a", { permission: "reports.view" })).rejects.toMatchObject({ reason: "missing-permission:reports.view" });
  });

  it("an override switching Reports off refuses it, even for the owner", async () => {
    await updateOverrides({ ...world, businessId: "biz-a", set: { modules: { reports: false } }, actor: "test", reason: "test: reports off" });
    await expect(guard(world.uids.ownera, "biz-a", { permission: "reports.view" })).rejects.toMatchObject({ reason: "module-disabled:reports" });
    expect((await callReports(world.uids.ownera, "biz-a")).status).toBe(403);
  });
});

describe("requireTenant: membership AND permission AND module", () => {
  it("allows correct permission + enabled module", async () => {
    await expect(guard(world.uids.managera, "biz-a", { permission: "inventory.view", module: "inventory" })).resolves.toBeTruthy();
  });

  it("denies a missing permission", async () => {
    await expect(guard(world.uids.staffa, "biz-a", { permission: "inventory.adjust" })).rejects.toMatchObject({ code: "forbidden", reason: "missing-permission:inventory.adjust" });
  });

  it("checks the permission's own module even when no module is passed", async () => {
    await disableInventoryForA();
    await expect(guard(world.uids.ownera, "biz-a", { permission: "inventory.costs" })).rejects.toMatchObject({ reason: "module-disabled:inventory" });
  });

  it("checks an extra module passed explicitly", async () => {
    await updateOverrides({ ...world, businessId: "biz-a", set: { modules: { customers: false } }, actor: "test", reason: "test: customers off" });
    await expect(guard(world.uids.ownera, "biz-a", { permission: "orders.view", module: "customers" })).rejects.toMatchObject({ reason: "module-disabled:customers" });
    await expect(guard(world.uids.ownera, "biz-a", { permission: "orders.view" })).resolves.toBeTruthy();
  });

  it("gives the same public error for 'no permission' and 'not on the package'", async () => {
    await disableInventoryForA();
    const a = await guard(world.uids.staffa, "biz-a", { permission: "inventory.view" }).catch((e) => e);
    const b = await guard(world.uids.staffa, "biz-a", { permission: "users.manage" }).catch((e) => e);
    expect([a.code, a.message, a.statusCode]).toEqual([b.code, b.message, b.statusCode]);
  });

  it("denies a disabled membership even with permission + module", async () => {
    await expect(guard(world.uids.disableda, "biz-a", { permission: "orders.view" })).rejects.toMatchObject({ code: "membership-disabled" });
  });

  it("rejects unknown permission or module ids as programming errors, before any read", async () => {
    await expect(guard(world.uids.ownera, "biz-a", { permission: "reports.everything" })).rejects.toThrow(/unknown permission/);
    await expect(guard(world.uids.ownera, "biz-a", { module: "teleport" })).rejects.toThrow(/unknown module/);
  });

  it("core modules still need a valid snapshot", async () => {
    delete businessDoc("biz-a").entitlements;
    await expect(guard(world.uids.ownera, "biz-a", { permission: "settings.view" })).rejects.toMatchObject({ code: "business-misconfigured", statusCode: 503 });
  });
});

describe("requireTenant: subscription states", () => {
  it("suspended: reads allowed, writes refused", async () => {
    await expect(guard(world.uids.owners, "biz-s", { permission: "orders.view" })).resolves.toBeTruthy();
    await expect(guard(world.uids.owners, "biz-s", { permission: "orders.create", write: true })).rejects.toMatchObject({ code: "read-only" });
  });

  it("cancelled: owner keeps export-only permissions; staff is refused", async () => {
    await expect(guard(world.uids.ownerx, "biz-x", { permission: "settings.view" })).resolves.toBeTruthy();
    await expect(guard(world.uids.ownerx, "biz-x", { permission: "orders.view" })).rejects.toMatchObject({ reason: "missing-permission:orders.view" });
    await expect(guard(world.uids.ownerx, "biz-x", { permission: "settings.view", write: true })).rejects.toMatchObject({ code: "read-only" });
    await expect(guard(world.uids.staffx, "biz-x", { permission: "dashboard.view" })).rejects.toMatchObject({ code: "account-cancelled" });
  });

  it("cancelled + module disabled: denied", async () => {
    await updateOverrides({ ...world, businessId: "biz-x", set: { modules: { reports: false } }, actor: "test", reason: "test: reports off" });
    await expect(guard(world.uids.ownerx, "biz-x", { permission: "reports.export" })).rejects.toMatchObject({ reason: "module-disabled:reports" });
  });
});

describe("requireTenant: cross tenant and browser-supplied values", () => {
  it("A owner selecting B is refused regardless of B's package", async () => {
    await updateOverrides({ ...world, businessId: "biz-b", set: { modules: { inventory: true }, limits: { users: 50 } }, actor: "test", reason: "test: generous B" });
    await expect(guard(world.uids.ownera, "biz-b", { permission: "reports.view" })).rejects.toMatchObject({ code: "business-access-denied" });
    expect((await callReports(world.uids.ownera, "biz-b")).status).toBe(403);
  });

  it("users/{uid}.businessIds listing B grants nothing", async () => {
    world.db.docs.get(`users/${world.uids.ownera}`).businessIds.push("biz-b");
    await expect(guard(world.uids.ownera, "biz-b", { permission: "orders.view" })).rejects.toMatchObject({ code: "business-access-denied" });
  });

  it("plan / module / role headers from the browser are ignored", async () => {
    await disableInventoryForA();
    const forged = { "x-luna-plan": "pro", "x-luna-module": "inventory", "x-luna-role": "owner", "x-luna-permissions": "inventory.view" };
    await expect(guard(world.uids.staffa, "biz-a", { permission: "inventory.view" }, forged)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("changing the stored roleTemplate label grants nothing", async () => {
    world.db.docs.get(`businesses/biz-a/members/${world.uids.staffa}`).roleTemplate = "owner";
    await expect(guard(world.uids.staffa, "biz-a", { permission: "inventory.adjust" })).rejects.toMatchObject({ reason: "missing-permission:inventory.adjust" });
  });
});

describe("requireTenant: malformed entitlements fail closed (503)", () => {
  const cases = {
    "missing snapshot": (b) => delete b.entitlements,
    "unknown plan (consistent but no plans/ doc)": (b) => {
      b.subscription.planId = "platinum";
      b.entitlements.planId = "platinum";
    },
    "stale snapshot (plan changed, not recomputed)": (b) => (b.subscription.planId = "pro"),
    "schemaVersion missing": (b) => delete b.entitlements.schemaVersion,
    "module value 'true'": (b) => (b.entitlements.modules.reports = "true"),
    "unknown module key": (b) => (b.entitlements.modules.teleport = true),
    "modules not a map": (b) => (b.entitlements.modules = ["orders"]),
    "limit not a number": (b) => (b.entitlements.limits.users = "lots"),
    "limits missing": (b) => delete b.entitlements.limits,
    "invalid feature value": (b) => (b.entitlements.features.support = "platinum"),
    "features missing": (b) => delete b.entitlements.features,
  };
  for (const [label, breakIt] of Object.entries(cases)) {
    it(label, async () => {
      breakIt(businessDoc("biz-a"));
      await expect(guard(world.uids.ownera, "biz-a", { permission: "orders.view" })).rejects.toMatchObject({ code: "business-misconfigured", statusCode: 503 });
      expect((await callReports(world.uids.ownera, "biz-a")).status).toBe(503);
    });
  }
});

describe("GET /api/reports", () => {
  it("401 without a token", async () => {
    const res = await createReportsHandler({ getAdmin: async () => world })(request({}));
    expect(res.statusCode).toBe(401);
  });

  it("403 for staff without reports.view; a manager gets 400 until a valid range is given", async () => {
    expect((await callReports(world.uids.staffa, "biz-a")).status).toBe(403);
    const r = await callReports(world.uids.managera, "biz-a");
    expect(r).toMatchObject({ status: 400, body: { error: "invalid-range" } });
  });
});
