// Phase 5: dashboard widget visibility (permission + entitlement), the
// financial/operational split, and the Expenses module registration.

import { describe, it, expect } from "vitest";
import { resolveDashboard, dashboardDocuments, DASHBOARD_WIDGETS } from "../../shared/dashboard.js";
import { computeEntitlements, validatePlan, validateEntitlementsSnapshot } from "../../shared/entitlements.js";
import { resolvePermissions, moduleForPermission, PERMISSIONS, ROLE_TEMPLATES } from "../../shared/permissions.js";
import { PLAN_SEED } from "../../shared/plans.seed.js";
import { getModule, MODULE_IDS, SELLABLE_MODULE_IDS, resolveNavigation, canUseModule, isModuleEnabled } from "../../shared/modules.js";
import { DEFAULT_EXPENSE_CATEGORIES } from "../../shared/expenses.js";

const growth = (overrides) => computeEntitlements(PLAN_SEED.growth, overrides, "distributor");
const ids = (widgets) => widgets.map((w) => w.id);
const financial = (widgets) => widgets.filter((w) => w.section === "financial");

describe("dashboard.financials separates profitability from operations", () => {
  it("owner and manager templates include it; staff does not", () => {
    expect(resolvePermissions("owner")["dashboard.financials"]).toBe(true);
    expect(resolvePermissions("manager")["dashboard.financials"]).toBe(true);
    expect(resolvePermissions("staff")["dashboard.financials"]).toBeUndefined();
  });

  it("staff see operations only", () => {
    const widgets = resolveDashboard({ entitlements: growth(), permissions: resolvePermissions("staff") });
    expect(financial(widgets)).toEqual([]);
    expect(ids(widgets)).toEqual(expect.arrayContaining(["ordersToday", "pendingFulfillment", "lowStock", "unpaidOrders"]));
  });

  it("owner sees sales, gross profit, expenses and estimated operating profit", () => {
    const widgets = resolveDashboard({ entitlements: growth(), permissions: resolvePermissions("owner") });
    expect(ids(financial(widgets))).toEqual(["netSales", "grossProfit", "operatingExpenses", "estimatedOperatingProfit", "paymentsReceived", "receivablesOutstanding"]);
  });

  it("a staff member granted dashboard.financials sees them; a manager with it revoked does not", () => {
    expect(financial(resolveDashboard({ entitlements: growth(), permissions: resolvePermissions("staff", { grant: ["dashboard.financials"] }) })).length).toBe(6);
    expect(financial(resolveDashboard({ entitlements: growth(), permissions: resolvePermissions("manager", { revoke: ["dashboard.financials"] }) }))).toEqual([]);
  });

  it("truthy non-boolean permission values grant nothing", () => {
    expect(resolveDashboard({ entitlements: growth(), permissions: { "dashboard.view": "true", "dashboard.financials": 1 } })).toEqual([]);
  });

  it("widgets disappear when a module they depend on isn't entitled", () => {
    const owner = resolvePermissions("owner");
    const noExpenses = ids(resolveDashboard({ entitlements: growth({ modules: { expenses: false } }), permissions: owner }));
    expect(noExpenses).not.toContain("operatingExpenses");
    expect(noExpenses).not.toContain("estimatedOperatingProfit");
    expect(noExpenses).toContain("netSales");
    const noInventory = ids(resolveDashboard({ entitlements: growth({ modules: { inventory: false } }), permissions: owner }));
    expect(noInventory).not.toContain("grossProfit");
    expect(noInventory).not.toContain("lowStock");
  });

  it("a broken snapshot shows nothing", () => {
    expect(resolveDashboard({ entitlements: { modules: { orders: "true" } }, permissions: resolvePermissions("owner") }).filter((w) => w.modules.length)).toEqual([]);
  });
});

describe("dashboardDocuments: a fixed, tiny read set", () => {
  it("owner: at most 4 documents for today, whatever the business size", () => {
    const docs = dashboardDocuments(resolveDashboard({ entitlements: growth(), permissions: resolvePermissions("owner") }), "2026-10-08");
    expect(docs.map((d) => `${d.collection}/${d.id}`).sort()).toEqual(["financialMetrics/2026-10-08", "financialMetrics/current", "metrics/2026-10-08", "metrics/current"]);
  });

  it("staff never request a financial document", () => {
    const docs = dashboardDocuments(resolveDashboard({ entitlements: growth(), permissions: resolvePermissions("staff") }), "2026-10-08");
    expect(docs.map((d) => d.collection)).not.toContain("financialMetrics");
    expect(docs).toHaveLength(2);
  });

  it("list widgets issue no query until their data exists (Phase 7: recent orders + low stock)", () => {
    const ready = DASHBOARD_WIDGETS.filter((x) => x.kind === "list" && x.ready).map((w) => w.id);
    expect(ready).toEqual(["recentOrders", "lowStockItems"]);
    for (const w of DASHBOARD_WIDGETS.filter((x) => x.kind === "list" && x.query)) expect(w.query.limit).toBeLessThanOrEqual(10);
  });

  it("every widget's permission belongs to the module that owns it", () => {
    for (const w of DASHBOARD_WIDGETS) expect(PERMISSIONS[w.permission], w.id).toBeTruthy();
  });
});

describe("Expenses module registration", () => {
  it("is registered, sellable and built (Phase 10); it owns the expenses collection", () => {
    const mod = getModule("expenses");
    expect(mod).toMatchObject({ id: "expenses", permission: "expenses.view", available: true, path: "/expenses" });
    expect(MODULE_IDS).toContain("expenses");
    expect(SELLABLE_MODULE_IDS).toContain("expenses");
    expect(mod.collections).toEqual({ expenses: "expenses.view" });
  });

  it("owns expenses.view / create / update / delete", () => {
    for (const key of ["expenses.view", "expenses.create", "expenses.update", "expenses.delete"]) expect(moduleForPermission(key)).toBe("expenses");
  });

  it("templates: owner and manager get expense permissions, staff gets none", () => {
    expect(Object.keys(resolvePermissions("owner")).filter((k) => k.startsWith("expenses."))).toHaveLength(4);
    expect(Object.keys(resolvePermissions("manager")).filter((k) => k.startsWith("expenses."))).toHaveLength(4);
    expect(Object.keys(resolvePermissions("staff")).filter((k) => k.startsWith("expenses."))).toHaveLength(0);
    expect(ROLE_TEMPLATES.staff.permissions).not.toContain("dashboard.financials");
  });

  it("every seeded plan includes Expenses (same strategy as the other operational modules)", () => {
    for (const plan of Object.values(PLAN_SEED)) {
      expect(plan.modules.expenses).toBe(true);
      expect(() => validatePlan(plan)).not.toThrow();
    }
  });

  it("Distributor: enabled, usable and navigable for owners; never for staff", () => {
    const access = { entitlements: growth(), permissions: resolvePermissions("owner") };
    expect(access.entitlements.modules.expenses).toBe(true);
    expect(canUseModule(access, "expenses")).toBe(true);
    expect(resolveNavigation(access).find((m) => m.id === "expenses").label).toBe("Operating Expenses");
    expect(canUseModule({ entitlements: growth(), permissions: resolvePermissions("staff") }, "expenses")).toBe(false);
  });

  it("an unbuilt module (Suppliers) is never enabled, usable or navigable, even granted by override", () => {
    const access = { entitlements: growth(), permissions: resolvePermissions("owner") };
    expect(access.entitlements.modules.suppliers).toBe(false);
    expect(canUseModule(access, "suppliers")).toBe(false);
  });

  it("a snapshot computed before Expenses existed is rejected until recomputed", () => {
    const old = growth();
    delete old.modules.expenses;
    expect(validateEntitlementsSnapshot(old, "growth", "distributor").problems).toContain("modules.expenses must be a boolean");
  });

  it("default categories have stable ids", () => {
    const catIds = DEFAULT_EXPENSE_CATEGORIES.map((c) => c.id);
    expect(new Set(catIds).size).toBe(catIds.length);
    expect(catIds).toEqual(["rent", "utilities", "delivery", "salaries", "marketing", "supplies", "packaging", "repairs", "fees", "misc"]);
  });
});
