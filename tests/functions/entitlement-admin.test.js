// Operator tooling: assign/change plan, add/remove overrides, recompute,
// describe. Every change is validated, recomputed in one transaction and
// audited; invalid input changes nothing.

import { describe, it, expect, beforeEach } from "vitest";
import {
  assignPlan,
  updateOverrides,
  refreshEntitlements,
  describeEntitlements,
  addMember,
  setMemberStatus,
  ensureAuthUser,
  ProvisioningError,
} from "../../netlify/functions/_lib/provisioning.js";
import { validateEntitlementsSnapshot } from "../../shared/entitlements.js";
import { PLAN_SEED } from "../../shared/plans.seed.js";
import { buildWorld } from "../helpers/tenants.js";

let world;
beforeEach(async () => {
  world = await buildWorld();
});

const biz = (id) => world.db.docs.get(`businesses/${id}`);
const auditDocs = (prefix) => [...world.db.docs.entries()].filter(([path]) => path.startsWith(prefix)).map(([, data]) => data);
const op = { actor: "ops@luna", reason: "unit test" };

describe("assignPlan", () => {
  it("moves a business to another plan and recomputes the snapshot", async () => {
    const result = await assignPlan({ ...world, ...op, businessId: "biz-b", planId: "pro" });
    expect(result.planId).toBe("pro");
    expect(biz("biz-b").subscription.planId).toBe("pro");
    expect(biz("biz-b").entitlements).toMatchObject({ schemaVersion: 2, planId: "pro", planName: "Pro", workspaceTemplateId: "distributor", workspaceTemplateVersion: 1, limits: PLAN_SEED.pro.limits });
    expect(validateEntitlementsSnapshot(biz("biz-b").entitlements, "pro", "distributor").ok).toBe(true);
  });

  it("writes the same audit record to the tenant auditLog and platformAudit", async () => {
    await assignPlan({ ...world, ...op, businessId: "biz-b", planId: "growth" });
    const [tenantAudit] = auditDocs("businesses/biz-b/auditLog/");
    const [platformAudit] = auditDocs("platformAudit/");
    expect(tenantAudit).toMatchObject({ type: "entitlements.plan-assigned", actor: "ops@luna", reason: "unit test", before: { planId: "starter" }, after: { planId: "growth" } });
    expect(platformAudit).toEqual(tenantAudit);
  });

  it.each([
    ["unknown plan", "platinum", "unknown-plan"],
    ["invalid plan id", "../pro", "unknown-plan"],
    ["empty plan id", "", "unknown-plan"],
  ])("rejects %s and changes nothing", async (_label, planId, code) => {
    const before = structuredClone(biz("biz-b"));
    await expect(assignPlan({ ...world, ...op, businessId: "biz-b", planId })).rejects.toMatchObject({ code });
    expect(biz("biz-b")).toEqual(before);
    expect(auditDocs("platformAudit/")).toHaveLength(0);
  });

  it("requires a reason", async () => {
    await expect(assignPlan({ ...world, businessId: "biz-b", planId: "pro", reason: "" })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("refuses an unknown business", async () => {
    await expect(assignPlan({ ...world, ...op, businessId: "biz-zzz", planId: "pro" })).rejects.toMatchObject({ code: "not-found" });
  });

  it("downgrade below the active user count warns and removes nobody", async () => {
    // biz-a: Growth, 4 active users; Starter allows 2.
    const result = await assignPlan({ ...world, ...op, businessId: "biz-a", planId: "starter" });
    expect(result.warnings[0]).toMatch(/4 active users exceed the new limit of 2/);
    expect(auditDocs("businesses/biz-a/members/").filter((m) => m.status === "active")).toHaveLength(4);
  });

  it("keeps overrides across a plan change", async () => {
    await updateOverrides({ ...world, ...op, businessId: "biz-b", set: { limits: { users: 4 } } });
    await assignPlan({ ...world, ...op, businessId: "biz-b", planId: "growth" });
    expect(biz("biz-b").entitlements.limits.users).toBe(4);
  });
});

describe("updateOverrides", () => {
  it("Founding Client: higher order limit, extra user, extra imports", async () => {
    const result = await updateOverrides({ ...world, ...op, businessId: "biz-b", set: { limits: { ordersPerMonth: 800, users: 3, importsPerMonth: 3 } } });
    expect(result.entitlements.limits).toMatchObject({ ordersPerMonth: 800, users: 3, importsPerMonth: 3 });
    expect(biz("biz-b").limitOverrides).toEqual({ ordersPerMonth: 800, users: 3, importsPerMonth: 3 });
  });

  it("disables and re-enables a module; clearing restores the plan default", async () => {
    await updateOverrides({ ...world, ...op, businessId: "biz-a", set: { modules: { reports: false } } });
    expect(biz("biz-a").entitlements.modules.reports).toBe(false);
    await updateOverrides({ ...world, ...op, businessId: "biz-a", clear: { modules: ["reports"] } });
    expect(biz("biz-a").entitlements.modules.reports).toBe(true);
    expect(biz("biz-a").moduleOverrides).toEqual({});
  });

  it("feature overrides", async () => {
    await updateOverrides({ ...world, ...op, businessId: "biz-b", set: { features: { googleSheets: true, support: "priority" } } });
    expect(biz("biz-b").entitlements.features).toMatchObject({ googleSheets: true, support: "priority" });
  });

  it.each([
    ["truthy string module", { modules: { reports: "true" } }],
    ["core module", { modules: { settings: false } }],
    ["unknown module", { modules: { teleport: true } }],
    ["negative limit", { limits: { users: -1 } }],
    ["string limit", { limits: { users: "10" } }],
    ["unknown limit", { limits: { galaxies: 1 } }],
    ["bad feature value", { features: { support: "platinum" } }],
    ["unknown feature", { features: { teleport: true } }],
  ])("rejects %s and changes nothing", async (_label, set) => {
    const before = structuredClone(biz("biz-b"));
    await expect(updateOverrides({ ...world, ...op, businessId: "biz-b", set })).rejects.toBeInstanceOf(ProvisioningError);
    expect(biz("biz-b")).toEqual(before);
    expect(auditDocs("platformAudit/")).toHaveLength(0);
  });

  it("rejects unknown override sections", async () => {
    await expect(updateOverrides({ ...world, ...op, businessId: "biz-b", set: { prices: { monthly: 0 } } })).rejects.toMatchObject({ code: "invalid-input" });
  });
});

describe("refreshEntitlements / describeEntitlements", () => {
  it("repairs a stale snapshot and records why", async () => {
    biz("biz-a").subscription.planId = "pro"; // plan changed by hand, snapshot still Growth
    const before = await describeEntitlements({ db: world.db, businessId: "biz-a" });
    expect(before.valid).toBe(false);
    expect(before.problems.join()).toMatch(/snapshot is for plan "growth"/);
    expect(before.recomputed.planId).toBe("pro");

    await refreshEntitlements({ ...world, businessId: "biz-a", actor: "ops@luna", reason: "repair stale snapshot" });
    expect((await describeEntitlements({ db: world.db, businessId: "biz-a" })).valid).toBe(true);
    expect(auditDocs("businesses/biz-a/auditLog/")[0]).toMatchObject({ type: "entitlements.recomputed", reason: "repair stale snapshot" });
  });

  it("describe never writes", async () => {
    const before = structuredClone([...world.db.docs.entries()]);
    await describeEntitlements({ db: world.db, businessId: "biz-b" });
    expect([...world.db.docs.entries()]).toEqual(before);
  });

  it("refresh refuses a business whose plan no longer exists", async () => {
    world.db.docs.delete("plans/starter");
    await expect(refreshEntitlements({ ...world, businessId: "biz-b" })).rejects.toMatchObject({ code: "unknown-plan" });
  });
});

describe("user limit uses the validated effective entitlements", () => {
  it("an override raises the limit for one business", async () => {
    await updateOverrides({ ...world, ...op, businessId: "biz-b", set: { limits: { users: 3 } } });
    const extra = await ensureAuthUser({ auth: world.auth, email: "extra@t.test", name: "Extra" });
    await addMember({ ...world, businessId: "biz-b", uid: extra.uid, email: extra.email, name: "Extra", roleTemplate: "staff" });
    expect(world.db.docs.get(`businesses/biz-b/members/${extra.uid}`).status).toBe("active");
  });

  it("a malformed snapshot blocks adding members instead of skipping the limit", async () => {
    biz("biz-b").entitlements.limits.users = "unlimited";
    const extra = await ensureAuthUser({ auth: world.auth, email: "extra@t.test", name: "Extra" });
    await expect(addMember({ ...world, businessId: "biz-b", uid: extra.uid, email: extra.email, name: "Extra", roleTemplate: "staff" })).rejects.toMatchObject({ code: "business-misconfigured" });
  });

  it("a missing snapshot blocks re-enabling a member (no silent bypass)", async () => {
    delete biz("biz-a").entitlements;
    await expect(setMemberStatus({ ...world, businessId: "biz-a", uid: world.uids.disableda, status: "active" })).rejects.toMatchObject({ code: "business-misconfigured" });
  });
});
