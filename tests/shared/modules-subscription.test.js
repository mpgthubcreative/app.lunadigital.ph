import { describe, it, expect } from "vitest";
import { resolveNavigation, isModuleEnabled } from "../../shared/modules.js";
import { accessPolicy, SUBSCRIPTION_STATUSES } from "../../shared/subscription.js";
import { computeEntitlements } from "../../shared/entitlements.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { PLAN_SEED } from "../../shared/plans.seed.js";

const ids = (nav) => nav.map((m) => m.id);

describe("resolveNavigation", () => {
  const entitlements = computeEntitlements(PLAN_SEED.growth, {}, "distributor");

  it("shows the owner every enabled, built module", () => {
    expect(ids(resolveNavigation({ entitlements, permissions: resolvePermissions("owner") }))).toEqual([
      "dashboard", "orders", "payments", "inventory", "users", "settings",
    ]);
  });

  it("hides modules the user lacks permission for", () => {
    const nav = ids(resolveNavigation({ entitlements, permissions: resolvePermissions("staff") }));
    expect(nav).toContain("orders");
    expect(nav).not.toContain("reports");
    expect(nav).not.toContain("users");
    expect(nav).not.toContain("settings");
  });

  it("hides modules the business is not entitled to", () => {
    const limited = computeEntitlements(PLAN_SEED.growth, { modules: { inventory: false } }, "distributor");
    expect(ids(resolveNavigation({ entitlements: limited, permissions: resolvePermissions("owner") }))).not.toContain("inventory");
  });

  it("unbuilt modules are false in the snapshot, can't be added by override, and a forged true grants nothing", () => {
    const e = computeEntitlements(PLAN_SEED.pro, {}, "distributor");
    expect(e.modules.suppliers).toBe(false);
    expect(() => computeEntitlements(PLAN_SEED.pro, { modules: { suppliers: true } }, "distributor")).toThrow(/isn't allowed/);
    expect(isModuleEnabled({ ...e, modules: { ...e.modules, suppliers: true } }, "suppliers")).toBe(false);
  });

  it("shows nothing without permissions", () => {
    expect(resolveNavigation({ entitlements, permissions: null })).toEqual([]);
  });
});

describe("accessPolicy", () => {
  it("covers every subscription status", () => {
    expect(SUBSCRIPTION_STATUSES).toEqual(["active", "past_due", "suspended", "cancelled"]);
  });

  it("makes suspended read-only and cancelled owner-only export", () => {
    expect(accessPolicy("active")).toMatchObject({ canRead: true, canWrite: true });
    expect(accessPolicy("past_due")).toMatchObject({ canRead: true, canWrite: true });
    expect(accessPolicy("suspended")).toMatchObject({ canRead: true, canWrite: false });
    expect(accessPolicy("cancelled")).toMatchObject({ canWrite: false, ownerOnly: true, exportOnly: true });
  });

  it("fails closed for unknown status", () => {
    expect(accessPolicy("free_forever")).toMatchObject({ canRead: false, canWrite: false });
    expect(accessPolicy(undefined)).toMatchObject({ canRead: false, canWrite: false });
  });
});
