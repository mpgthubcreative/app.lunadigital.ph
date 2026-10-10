// Phase 18: the shared metering registry and its pure rules.
import { describe, it, expect } from "vitest";
import {
  METERS,
  METER_IDS,
  MONTHLY_METER_IDS,
  RUNNING_METER_IDS,
  RECORD_CREATION_METER_IDS,
  LIMIT_METER,
  ENFORCED_METER_IDS,
  LIMIT_OVERRIDE_MAX,
  validateLimitOverride,
  effectiveLimit,
  limitRows,
  usagePercent,
  overrideImpact,
  thresholdUnits,
  crossedThresholds,
  runningAlerts,
  monthlyAlertKey,
  runningAlertKey,
  previousPeriods,
  historyRows,
  meterApplies,
  isEnforced,
} from "../../shared/metering.js";
import { LIMIT_KEYS } from "../../shared/plans.seed.js";
import { MODULES } from "../../shared/modules.js";
import { PLAN_SEED } from "../../shared/plans.seed.js";

describe("registry", () => {
  it("every plan limit has exactly one meter; enforced = has a limit; nothing else is enforced", () => {
    expect(Object.keys(LIMIT_METER).sort()).toEqual([...LIMIT_KEYS].sort());
    expect(LIMIT_METER).toEqual({ users: "activeUsers", ordersPerMonth: "ordersCreated", storageBytes: "storageBytes", importsPerMonth: "excelImports" });
    expect([...ENFORCED_METER_IDS].sort()).toEqual(["activeUsers", "excelImports", "ordersCreated", "storageBytes"]);
    for (const id of ["exportsGenerated", "rowsExported", "paymentsRecorded", "expensesCreated", "scheduledPaymentsPaid", "supplierPaymentsPaid", "guestsAdded", "payrollsReleased"]) expect(isEnforced(id), id).toBe(false);
  });

  it("existing counters keep their names; storage and users are running totals; the rest are monthly", () => {
    for (const id of ["ordersCreated", "excelImports", "exportsGenerated", "rowsExported"]) expect(MONTHLY_METER_IDS).toContain(id);
    expect([...RUNNING_METER_IDS].sort()).toEqual(["activeUsers", "storageBytes"]);
    expect(METER_IDS.length).toBe(MONTHLY_METER_IDS.length + RUNNING_METER_IDS.length);
  });

  it("every meter has a label, a unit, a written definition and a real module (or none = every workspace)", () => {
    const moduleIds = MODULES.map((m) => m.id);
    for (const [id, m] of Object.entries(METERS)) {
      expect(m.label, id).toBeTruthy();
      expect(["count", "bytes"]).toContain(m.unit);
      expect(m.definition.length, id).toBeGreaterThan(30);
      if (m.module !== null) expect(moduleIds, id).toContain(m.module);
    }
  });

  it("'records created' is a documented allowlist of distinct record creations: no paid events, imports, exports or audit", () => {
    expect([...RECORD_CREATION_METER_IDS].sort()).toEqual(["expensesCreated", "guestsAdded", "ordersCreated", "paymentsRecorded"]);
  });

  it("applicability follows the business's modules (Payroll meters don't show for a Distributor)", () => {
    const dist = { modules: { orders: true, payments: true, expenses: true, payroll: false } };
    expect(meterApplies("ordersCreated", dist)).toBe(true);
    expect(meterApplies("payrollsReleased", dist)).toBe(false);
    expect(meterApplies("exportsGenerated", dist)).toBe(true);
    expect(meterApplies("nope", dist)).toBe(false);
  });
});

describe("limits", () => {
  it("override validation: recognised limit keys only; whole numbers 0..max; null clears", () => {
    expect(validateLimitOverride("ordersPerMonth", 2000)).toBe(2000);
    expect(validateLimitOverride("ordersPerMonth", null)).toBeNull();
    expect(validateLimitOverride("users", 0)).toBe(0);
    for (const [k, v] of [["magicLimit", 999999], ["__proto__", 1], ["ordersPerMonth", -1], ["ordersPerMonth", 1.5], ["ordersPerMonth", "10"], ["ordersPerMonth", undefined], ["users", LIMIT_OVERRIDE_MAX.users + 1]]) {
      expect(() => validateLimitOverride(k, v), `${k}=${v}`).toThrow();
    }
  });

  it("effective limit comes from the snapshot; malformed = null (refuse)", () => {
    expect(effectiveLimit({ limits: { ordersPerMonth: 5 } }, "ordersPerMonth")).toBe(5);
    expect(effectiveLimit({ limits: { ordersPerMonth: -1 } }, "ordersPerMonth")).toBeNull();
    expect(effectiveLimit(null, "ordersPerMonth")).toBeNull();
  });

  it("limit rows: Plan | Override | Effective | Current | %", () => {
    const rows = limitRows({ plan: PLAN_SEED.starter, overrides: { ordersPerMonth: 1000 }, entitlements: { limits: { ...PLAN_SEED.starter.limits, ordersPerMonth: 1000 } }, usage: { ordersCreated: 284, activeUsers: 2 } });
    expect(rows.find((r) => r.limitKey === "ordersPerMonth")).toMatchObject({ plan: 500, override: 1000, effective: 1000, current: 284, percent: 28, atOrOver: false, kind: "monthly" });
    expect(rows.find((r) => r.limitKey === "users")).toMatchObject({ plan: 2, override: null, effective: 2, current: 2, percent: 100, atOrOver: true, kind: "running" });
    expect(usagePercent(5, 0)).toBeNull();
  });

  it("the warning before lowering a limit to / below what's used", () => {
    expect(overrideImpact({ limitKey: "ordersPerMonth", value: 400, current: 420 })).toMatch(/420 already used.*400.*blocked until next month/);
    expect(overrideImpact({ limitKey: "users", value: 2, current: 3 })).toMatch(/Nobody is deactivated/);
    expect(overrideImpact({ limitKey: "storageBytes", value: 10, current: 20 })).toMatch(/new uploads are blocked/);
    expect(overrideImpact({ limitKey: "ordersPerMonth", value: 500, current: 420 })).toBeNull();
    expect(overrideImpact({ limitKey: "ordersPerMonth", value: null, current: 420 })).toBeNull();
  });
});

describe("warnings", () => {
  it("monthly: a threshold fires only when crossed (before < need <= after)", () => {
    expect(thresholdUnits(500, 80)).toBe(400);
    expect(thresholdUnits(2, 80)).toBe(2);
    expect(crossedThresholds(399, 400, 500)).toEqual([80]);
    expect(crossedThresholds(400, 401, 500)).toEqual([]);
    expect(crossedThresholds(499, 500, 500)).toEqual([100]);
    expect(crossedThresholds(1, 2, 2)).toEqual([80, 100]);
    expect(crossedThresholds(0, 1, 0)).toEqual([]);
    expect(monthlyAlertKey("ordersCreated", "2026-10", 80)).toBe("ordersCreated-2026-10-80");
  });

  it("running: once per episode, re-armed below (t - 10)%, then a new episode", () => {
    let s = runningAlerts(null, 79, 100);
    expect(s.fire).toEqual([]);
    s = runningAlerts(s.next, 80, 100);
    expect(s.fire).toEqual([{ threshold: 80, episode: 1 }]);
    s = runningAlerts(s.next, 95, 100);
    expect(s.fire).toEqual([]);
    s = runningAlerts(s.next, 71, 100); // still above 70%: stays armed-off
    expect(s.fire).toEqual([]);
    expect(s.next[80].open).toBe(true);
    s = runningAlerts(s.next, 69, 100);
    expect(s.next[80]).toEqual({ episode: 1, open: false });
    s = runningAlerts(s.next, 100, 100);
    expect(s.fire).toEqual([{ threshold: 80, episode: 2 }, { threshold: 100, episode: 1 }]);
    expect(runningAlertKey("storageBytes", 2, 80)).toBe("storageBytes-e2-80");
    expect(runningAlerts(null, 5, null).fire).toEqual([]);
  });
});

describe("history", () => {
  it("previous periods wrap the year", () => {
    expect(previousPeriods("2026-02", 4)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
    expect(() => previousPeriods("2026-13")).toThrow();
  });

  it("no document = no recorded usage (nulls); absent counter in a recorded month = 0; not metered yet = null", () => {
    const rows = historyRows(["2026-10", "2026-09", "2026-08"], [{ ordersCreated: 3, paymentsRecorded: 2, timezone: "Asia/Manila" }, null, { ordersCreated: 1 }]);
    expect(rows[0]).toMatchObject({ period: "2026-10", recorded: true, timezone: "Asia/Manila", recordsCreated: 5 });
    expect(rows[0].values).toMatchObject({ ordersCreated: 3, excelImports: 0, paymentsRecorded: 2 });
    expect(rows[1]).toMatchObject({ recorded: false, recordsCreated: null });
    expect(Object.values(rows[1].values).every((v) => v === null)).toBe(true);
    expect(rows[2].values).toMatchObject({ ordersCreated: 1, paymentsRecorded: null, exportsGenerated: 0 });
    expect(rows[2].recordsCreated).toBe(1);
  });
});
