// Phase 4: plan validation, strict overrides, the snapshot shape, and
// fail-closed snapshot validation.

import { describe, it, expect } from "vitest";
import { PLAN_SEED, LIMIT_KEYS, FEATURE_KEYS, FEATURE_DEFINITIONS } from "../../shared/plans.seed.js";
import {
  computeEntitlements,
  validatePlan,
  validateOverrides,
  validateEntitlementsSnapshot,
  isValidPlanId,
  ENTITLEMENTS_SCHEMA_VERSION,
  EntitlementError,
} from "../../shared/entitlements.js";
import { MODULE_IDS, CORE_MODULE_IDS, SELLABLE_MODULE_IDS } from "../../shared/modules.js";

const growth = () => structuredClone(PLAN_SEED.growth);

describe("validatePlan", () => {
  it("accepts every seeded plan", () => {
    for (const plan of Object.values(PLAN_SEED)) expect(() => validatePlan(plan)).not.toThrow();
  });

  it.each([
    ["bad id", (p) => (p.id = "Growth Plan")],
    ["missing name", (p) => (p.name = "")],
    ["fractional price", (p) => (p.pricing.monthly = 1990.5)],
    ["negative setup fee", (p) => (p.pricing.setupFee = -1)],
    ["non-boolean minimum flag", (p) => (p.pricing.monthlyIsMinimum = "yes")],
    ["module value not boolean", (p) => (p.modules.reports = "true")],
    ["unknown module", (p) => (p.modules.teleport = true)],
    ["core module in plan", (p) => (p.modules.dashboard = false)],
    ["missing limit", (p) => delete p.limits.users],
    ["string limit", (p) => (p.limits.users = "5")],
    ["unknown limit", (p) => (p.limits.galaxies = 1)],
    ["invalid enum feature", (p) => (p.features.reportsLevel = "premium")],
    ["non-boolean feature", (p) => (p.features.googleSheets = 1)],
    ["unknown feature", (p) => (p.features.teleport = true)],
    ["missing feature", (p) => delete p.features.support],
  ])("rejects a plan with %s", (_label, mutate) => {
    const plan = growth();
    mutate(plan);
    expect(() => validatePlan(plan)).toThrow(EntitlementError);
  });

  it("plan ids are lowercase slugs", () => {
    expect(isValidPlanId("growth")).toBe(true);
    expect(isValidPlanId("founding-2026")).toBe(true);
    for (const bad of ["", "G", "Growth", "a", "has space", "../pro", null, 7]) expect(isValidPlanId(bad)).toBe(false);
  });
});

describe("validateOverrides", () => {
  it("accepts module, limit and feature overrides", () => {
    expect(validateOverrides({ modules: { reports: false }, limits: { users: 3 }, features: { googleSheets: true } })).toEqual({
      modules: { reports: false },
      limits: { users: 3 },
      features: { googleSheets: true },
    });
  });

  it.each([
    ["truthy string module", { modules: { reports: "true" } }],
    ["numeric module", { modules: { reports: 1 } }],
    ["core module", { modules: { settings: false } }],
    ["unknown module", { modules: { teleport: true } }],
    ["negative limit", { limits: { users: -1 } }],
    ["fractional limit", { limits: { users: 2.5 } }],
    ["string limit", { limits: { users: "3" } }],
    ["unknown limit", { limits: { galaxies: 1 } }],
    ["invalid feature value", { features: { support: "platinum" } }],
    ["unknown feature", { features: { teleport: true } }],
    ["unknown section", { prices: { monthly: 0 } }],
    ["array section", { modules: ["reports"] }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => validateOverrides(overrides)).toThrow(EntitlementError);
  });
});

describe("computeEntitlements (snapshot shape)", () => {
  it("produces a complete schemaVersion 1 snapshot", () => {
    const e = computeEntitlements(PLAN_SEED.starter, {}, "distributor");
    expect(e.schemaVersion).toBe(ENTITLEMENTS_SCHEMA_VERSION);
    expect(e).toMatchObject({ planId: "starter", planName: "Starter" });
    expect(Object.keys(e.modules).sort()).toEqual([...MODULE_IDS].sort());
    expect(Object.keys(e.limits).sort()).toEqual([...LIMIT_KEYS].sort());
    expect(Object.keys(e.features).sort()).toEqual([...FEATURE_KEYS].sort());
    for (const id of CORE_MODULE_IDS) expect(e.modules[id]).toBe(true);
  });

  it("plan disables a module, override enables it (and the reverse)", () => {
    const lite = { ...growth(), id: "lite", name: "Lite", modules: { ...growth().modules, payments: false } };
    expect(computeEntitlements(lite, {}, "distributor").modules.payments).toBe(false);
    expect(computeEntitlements(lite, { modules: { payments: true } }, "distributor").modules.payments).toBe(true);
    expect(computeEntitlements(PLAN_SEED.growth, { modules: { payments: false } }, "distributor").modules.payments).toBe(false);
  });

  it("Founding Client style overrides: more orders, an extra user, extra imports", () => {
    const e = computeEntitlements(PLAN_SEED.starter, { limits: { ordersPerMonth: 800, users: 3, importsPerMonth: 4 } }, "distributor");
    expect(e.limits).toEqual({ users: 3, ordersPerMonth: 800, storageBytes: PLAN_SEED.starter.limits.storageBytes, importsPerMonth: 4 });
  });

  it("every computed snapshot passes validation for its plan", () => {
    for (const plan of Object.values(PLAN_SEED)) {
      expect(validateEntitlementsSnapshot(computeEntitlements(plan, {}, "distributor"), plan.id, "distributor")).toEqual({ ok: true, problems: [] });
    }
  });
});

describe("real plan differences (seeded definitions)", () => {
  const [starter, growthE, pro] = ["starter", "growth", "pro"].map((id) => computeEntitlements(PLAN_SEED[id], {}, "distributor"));

  it("limits grow Starter < Growth < Pro", () => {
    for (const key of LIMIT_KEYS) {
      expect(starter.limits[key]).toBeLessThan(growthE.limits[key]);
      expect(growthE.limits[key]).toBeLessThan(pro.limits[key]);
    }
  });

  it("features differ by plan", () => {
    expect(starter.features).toMatchObject({ reportsLevel: "basic", pushNotifications: false, googleSheets: false, support: "standard" });
    expect(growthE.features).toMatchObject({ reportsLevel: "advanced", pushNotifications: true, googleSheets: true, advancedPermissions: false });
    expect(pro.features).toMatchObject({ advancedPermissions: true, workflowCustomization: true });
  });

  it("module sets are currently identical across plans (commercial definition unchanged)", () => {
    expect(starter.modules).toEqual(growthE.modules);
    expect(growthE.modules).toEqual(pro.modules);
  });

  it("only sellable modules appear in plans", () => {
    for (const plan of Object.values(PLAN_SEED)) for (const id of Object.keys(plan.modules)) expect(SELLABLE_MODULE_IDS).toContain(id);
  });

  it("every feature in FEATURE_DEFINITIONS is set by every plan", () => {
    for (const plan of Object.values(PLAN_SEED)) for (const key of Object.keys(FEATURE_DEFINITIONS)) expect(plan.features).toHaveProperty(key);
  });
});

describe("validateEntitlementsSnapshot fails closed", () => {
  // Each case maps a valid Growth snapshot to a broken one.
  const edit = (fn) => (s) => {
    fn(s);
    return s;
  };

  it.each([
    ["missing snapshot", () => undefined],
    ["null snapshot", () => null],
    ["array snapshot", () => []],
    ["no schemaVersion", edit((s) => delete s.schemaVersion)],
    ["future schemaVersion", edit((s) => (s.schemaVersion = 3))],
    ["stale plan (snapshot for pro)", edit((s) => (s.planId = "pro"))],
    ["invalid planId", edit((s) => (s.planId = "Growth!"))],
    ["modules not a map", edit((s) => (s.modules = ["reports"]))],
    ["module 'true' string", edit((s) => (s.modules.reports = "true"))],
    ["module 1", edit((s) => (s.modules.reports = 1))],
    ["module missing", edit((s) => delete s.modules.orders)],
    ["unknown module", edit((s) => (s.modules.teleport = true))],
    ["core module off", edit((s) => (s.modules.dashboard = false))],
    ["limits missing", edit((s) => delete s.limits)],
    ["limit string", edit((s) => (s.limits.users = "5"))],
    ["limit negative", edit((s) => (s.limits.ordersPerMonth = -1))],
    ["limit missing key", edit((s) => delete s.limits.storageBytes)],
    ["unknown limit", edit((s) => (s.limits.galaxies = 1))],
    ["features not a map", edit((s) => (s.features = "all"))],
    ["invalid feature value", edit((s) => (s.features.support = "platinum"))],
    ["unknown feature", edit((s) => (s.features.teleport = true))],
  ])("%s", (_label, breakIt) => {
    expect(validateEntitlementsSnapshot(breakIt(computeEntitlements(PLAN_SEED.growth, {}, "distributor")), "growth", "distributor").ok).toBe(false);
  });

  it("a business with no valid subscription.planId", () => {
    const s = computeEntitlements(PLAN_SEED.growth, {}, "distributor");
    expect(validateEntitlementsSnapshot(s, undefined, "distributor").ok).toBe(false);
    expect(validateEntitlementsSnapshot(s, "", "distributor").ok).toBe(false);
  });
});
