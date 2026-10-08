// Phase 5 server side: the metrics writer (atomic, business-local, strict),
// member permission resync, and Expenses authorization while unbuilt.

import { describe, it, expect, beforeEach } from "vitest";
import { recordDailyMetrics, adjustCurrentMetrics } from "../../netlify/functions/_lib/metrics.js";
import { resyncMemberPermissions, updateOverrides } from "../../netlify/functions/_lib/provisioning.js";
import { requireTenant } from "../../netlify/functions/_lib/tenant.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { OPERATIONAL_COUNTERS, FINANCIAL_COUNTERS } from "../../shared/metrics.js";

let world;
beforeEach(async () => {
  world = await buildWorld();
});

const doc = (path) => world.db.docs.get(path);
const record = (args) => world.db.runTransaction(async (tx) => recordDailyMetrics({ tx, tenant: tenantDb(world.db, "biz-a"), FieldValue, timezone: "Asia/Manila", ...args }));

describe("recordDailyMetrics", () => {
  it("writes the business-local day and its month, with every counter present", async () => {
    const at = new Date("2026-10-07T16:30:00Z"); // 00:30 on 2026-10-08 in Manila
    const { day, month } = await record({ at, operational: { orderCount: 1 }, financial: { grossSales: 150000, cogs: 90000 } });
    expect([day, month]).toEqual(["2026-10-08", "2026-10"]);
    const d = doc("businesses/biz-a/metrics/2026-10-08");
    expect(d).toMatchObject({ schemaVersion: 1, period: "day", timezone: "Asia/Manila", orderCount: 1, fulfilledOrders: 0, cancelledOrders: 0 });
    for (const key of Object.keys(OPERATIONAL_COUNTERS)) expect(Number.isInteger(d[key])).toBe(true);
    const f = doc("businesses/biz-a/financialMetrics/2026-10-08");
    for (const key of Object.keys(FINANCIAL_COUNTERS)) expect(Number.isInteger(f[key])).toBe(true);
    expect(f).toMatchObject({ grossSales: 150000, cogs: 90000, discounts: 0 });
    expect(doc("businesses/biz-a/metrics/2026-10")).toMatchObject({ period: "month", orderCount: 1 });
    expect(doc("businesses/biz-a/metrics/2026-10-07")).toBeUndefined();
  });

  it("accumulates with increments (and allows negative corrections)", async () => {
    const at = new Date("2026-10-08T02:00:00Z");
    await record({ at, operational: { orderCount: 1 }, financial: { grossSales: 1000 } });
    await record({ at, operational: { orderCount: 2 }, financial: { grossSales: 2500 } });
    await record({ at, financial: { grossSales: -500, returns: 500 } });
    expect(doc("businesses/biz-a/metrics/2026-10-08").orderCount).toBe(3);
    expect(doc("businesses/biz-a/financialMetrics/2026-10-08")).toMatchObject({ grossSales: 3000, returns: 500 });
    expect(doc("businesses/biz-a/financialMetrics/2026-10").grossSales).toBe(3000);
  });

  it("only touches the collection(s) it was given", async () => {
    await record({ at: new Date("2026-10-08T02:00:00Z"), operational: { orderCount: 1 } });
    expect(doc("businesses/biz-a/financialMetrics/2026-10-08")).toBeUndefined();
  });

  it.each([
    ["unknown field", { operational: { orders: 1 } }],
    ["money in the operational doc", { operational: { grossSales: 100 } }],
    ["fractional centavos", { financial: { grossSales: 10.5 } }],
    ["string amount", { financial: { grossSales: "100" } }],
  ])("rejects %s and writes nothing", async (_label, args) => {
    const before = world.db.docs.size;
    await expect(record({ at: new Date("2026-10-08T02:00:00Z"), ...args })).rejects.toThrow(/metrics:/);
    expect(world.db.docs.size).toBe(before);
  });

  it("refuses an invalid timezone instead of guessing a day", async () => {
    await expect(record({ timezone: "Nowhere/City", at: new Date(), operational: { orderCount: 1 } })).rejects.toThrow(RangeError);
  });
});

describe("adjustCurrentMetrics", () => {
  it("moves gauges up and down on the current documents", async () => {
    const adjust = (args) => world.db.runTransaction(async (tx) => adjustCurrentMetrics({ tx, tenant: tenantDb(world.db, "biz-a"), FieldValue, ...args }));
    await adjust({ operational: { pendingFulfillment: 2 }, financial: { receivablesOutstanding: 5000 } });
    await adjust({ operational: { pendingFulfillment: -1 } });
    expect(doc("businesses/biz-a/metrics/current")).toMatchObject({ period: "current", pendingFulfillment: 1, unpaidOrders: 0, lowStockProducts: 0 });
    expect(doc("businesses/biz-a/financialMetrics/current").receivablesOutstanding).toBe(5000);
    await expect(adjust({ operational: { orderCount: 1 } })).rejects.toThrow(/unknown operational gauge/);
  });
});

describe("resyncMemberPermissions", () => {
  const member = (uid) => doc(`businesses/biz-a/members/${uid}`);

  it("gives existing owners/managers newly added keys; staff stay unchanged", async () => {
    for (const uid of [world.uids.ownera, world.uids.managera]) {
      const m = member(uid);
      delete m.permissions["dashboard.financials"];
      delete m.permissions["expenses.view"];
    }
    const before = structuredClone(member(world.uids.staffa).permissions);
    const result = await resyncMemberPermissions({ ...world, businessId: "biz-a", actor: "test", reason: "add Phase 5 keys" });
    expect(member(world.uids.ownera).permissions["dashboard.financials"]).toBe(true);
    expect(member(world.uids.managera).permissions["expenses.view"]).toBe(true);
    expect(member(world.uids.staffa).permissions).toEqual(before);
    expect(result.changes.map((c) => c.uid).sort()).toEqual([world.uids.ownera, world.uids.managera].sort());
    const audit = [...world.db.docs.entries()].find(([p]) => p.startsWith("businesses/biz-a/auditLog/"))[1];
    expect(audit).toMatchObject({ type: "permissions.resynced", reason: "add Phase 5 keys" });
  });

  it("keeps per-member revokes and grants", async () => {
    const m = member(world.uids.managera);
    m.permissionOverrides = { grant: [], revoke: ["dashboard.financials"] };
    m.permissions["dashboard.financials"] = true; // stale map
    await resyncMemberPermissions({ ...world, businessId: "biz-a", reason: "resync" });
    expect(member(world.uids.managera).permissions["dashboard.financials"]).toBeUndefined();
  });

  it("skips members with an unknown template and writes no audit when nothing changed", async () => {
    member(world.uids.staffa).roleTemplate = "warehouse";
    const result = await resyncMemberPermissions({ ...world, businessId: "biz-a", reason: "resync" });
    expect(result.changes).toEqual([]);
    expect(result.skipped.map((s) => s.uid)).toEqual([world.uids.staffa]);
    expect([...world.db.docs.keys()].some((p) => p.startsWith("businesses/biz-a/auditLog/"))).toBe(false);
  });

  it("requires a reason", async () => {
    await expect(resyncMemberPermissions({ ...world, businessId: "biz-a", reason: "" })).rejects.toMatchObject({ code: "invalid-input" });
  });
});

describe("Expenses authorization while the module is unbuilt", () => {
  const guard = (uid, businessId, opts) => requireTenant(request({ uid, businessId }), { db: world.db, auth: world.auth, ...opts });

  it("owner with the module entitled is still denied (not available yet)", async () => {
    expect(doc("businesses/biz-a").entitlements.modules.expenses).toBe(true);
    await expect(guard(world.uids.ownera, "biz-a", { permission: "expenses.view" })).rejects.toMatchObject({ code: "forbidden", reason: "module-disabled:expenses" });
    await expect(guard(world.uids.ownera, "biz-a", { permission: "expenses.create", write: true })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("entitlement disabled -> denied", async () => {
    await updateOverrides({ ...world, businessId: "biz-a", set: { modules: { expenses: false } }, actor: "test", reason: "expenses off" });
    await expect(guard(world.uids.ownera, "biz-a", { permission: "expenses.view" })).rejects.toMatchObject({ reason: "module-disabled:expenses" });
  });

  it("permission missing -> denied (staff)", async () => {
    await expect(guard(world.uids.staffa, "biz-a", { permission: "expenses.view" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("cross-tenant -> denied", async () => {
    await expect(guard(world.uids.ownera, "biz-b", { permission: "expenses.view" })).rejects.toMatchObject({ code: "business-access-denied" });
  });

  it("malformed snapshot (pre-Expenses, 12 modules) -> 503 until recomputed", async () => {
    delete doc("businesses/biz-a").entitlements.modules.expenses;
    await expect(guard(world.uids.ownera, "biz-a", { permission: "dashboard.view" })).rejects.toMatchObject({ code: "business-misconfigured", statusCode: 503 });
  });

  it("dashboard.financials needs the Dashboard module and the exact permission", async () => {
    await expect(guard(world.uids.ownera, "biz-a", { permission: "dashboard.financials" })).resolves.toBeTruthy();
    await expect(guard(world.uids.managera, "biz-a", { permission: "dashboard.financials" })).resolves.toBeTruthy();
    await expect(guard(world.uids.staffa, "biz-a", { permission: "dashboard.financials" })).rejects.toMatchObject({ reason: "missing-permission:dashboard.financials" });
  });
});
