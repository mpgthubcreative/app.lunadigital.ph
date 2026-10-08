import { describe, it, expect } from "vitest";
import { PLAN_SEED, LIMIT_KEYS, formatMoney } from "../../shared/plans.seed.js";
import { computeEntitlements } from "../../shared/entitlements.js";
import { MODULE_IDS } from "../../shared/modules.js";

describe("plan seed", () => {
  const plans = Object.values(PLAN_SEED);

  it("has starter, growth and pro with growth recommended", () => {
    expect(Object.keys(PLAN_SEED)).toEqual(["starter", "growth", "pro"]);
    expect(plans.filter((p) => p.recommended).map((p) => p.id)).toEqual(["growth"]);
  });

  it("defines every limit as a non-negative integer", () => {
    for (const plan of plans) {
      for (const key of LIMIT_KEYS) {
        expect(Number.isInteger(plan.limits[key]) && plan.limits[key] >= 0, `${plan.id}.${key}`).toBe(true);
      }
    }
  });

  it("only references known modules", () => {
    for (const plan of plans) {
      for (const id of Object.keys(plan.modules)) expect(MODULE_IDS).toContain(id);
    }
  });

  it("stores the agreed initial pricing in centavos", () => {
    expect(formatMoney(PLAN_SEED.starter.pricing.setupFee)).toBe("₱4,990");
    expect(formatMoney(PLAN_SEED.starter.pricing.monthly)).toBe("₱990");
    expect(formatMoney(PLAN_SEED.growth.pricing.setupFee)).toBe("₱9,990");
    expect(formatMoney(PLAN_SEED.growth.pricing.monthly)).toBe("₱1,990");
    expect(formatMoney(PLAN_SEED.pro.pricing.setupFee, { minimum: true })).toBe("₱19,990+");
    expect(formatMoney(PLAN_SEED.pro.pricing.monthly, { minimum: true })).toBe("₱2,990+");
  });
});

describe("computeEntitlements", () => {
  it("uses plan defaults when there are no overrides", () => {
    const e = computeEntitlements(PLAN_SEED.starter, {}, "distributor");
    expect(e.planId).toBe("starter");
    expect(e.limits.ordersPerMonth).toBe(500);
    expect(e.modules.orders).toBe(true);
    expect(e.modules.suppliers).toBe(false);
  });

  it("applies per-business module, limit and feature overrides", () => {
    const e = computeEntitlements(PLAN_SEED.starter, {
      modules: { inventory: false },
      limits: { users: 3 },
      features: { pushNotifications: true },
    }, "distributor");
    expect(e.modules.inventory).toBe(false);
    expect(e.modules.orders).toBe(true);
    expect(e.limits.users).toBe(3);
    expect(e.limits.ordersPerMonth).toBe(500);
    expect(e.features.pushNotifications).toBe(true);
  });

  it("rejects unknown or invalid overrides", () => {
    expect(() => computeEntitlements(PLAN_SEED.starter, { modules: { teleport: true } }, "distributor")).toThrow();
    expect(() => computeEntitlements(PLAN_SEED.starter, { limits: { users: -1 } }, "distributor")).toThrow();
    expect(() => computeEntitlements(PLAN_SEED.starter, { limits: { users: 2.5 } }, "distributor")).toThrow();
    expect(() => computeEntitlements(PLAN_SEED.starter, { limits: { galaxies: 1 } }, "distributor")).toThrow();
  });

  it("does not mutate the plan", () => {
    const before = JSON.stringify(PLAN_SEED.growth);
    computeEntitlements(PLAN_SEED.growth, { limits: { users: 99 } }, "distributor");
    expect(JSON.stringify(PLAN_SEED.growth)).toBe(before);
  });
});
