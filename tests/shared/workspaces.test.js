// Phase 8.5: workspace templates. Registry shape, plan/template
// independence, the effective-module calculation (template ceiling, plan,
// overrides), fail-closed snapshot validation, navigation and dashboard.

import { describe, it, expect } from "vitest";
import {
  WORKSPACE_TEMPLATES,
  WORKSPACE_TEMPLATE_IDS,
  getWorkspaceTemplate,
  validateWorkspaceTemplate,
  workspaceAllowsModule,
  snapshotWorkspaceTemplateId,
  isSafeLabel,
} from "../../shared/workspaces.js";
import { MODULES, MODULE_IDS, CORE_MODULE_IDS, getModule, isModuleEnabled, canUseModule, resolveNavigation } from "../../shared/modules.js";
import { computeEntitlements, validateEntitlementsSnapshot, ENTITLEMENTS_SCHEMA_VERSION } from "../../shared/entitlements.js";
import { DASHBOARD_WIDGETS, resolveDashboard, dashboardDocuments, dashboardEmptyState } from "../../shared/dashboard.js";
import { PLAN_SEED } from "../../shared/plans.seed.js";
import { PERMISSIONS, resolvePermissions } from "../../shared/permissions.js";

const NON_DISTRIBUTOR = ["household-payroll", "baby-expense", "bridal-expense"];
const DISTRIBUTOR_MODULES = ["orders", "payments", "inventory", "customers", "reports", "imports"];
const BUILT = MODULES.filter((m) => m.available).map((m) => m.id);
const UNBUILT = MODULES.filter((m) => !m.available).map((m) => m.id);
const CTX = { moduleIds: MODULE_IDS, coreModuleIds: CORE_MODULE_IDS, availableModuleIds: BUILT, widgets: DASHBOARD_WIDGETS };
const ent = (templateId, planId = "pro", overrides = {}) => computeEntitlements(PLAN_SEED[planId], overrides, templateId);
const access = (templateId, role = "owner", planId = "pro") => ({ entitlements: ent(templateId, planId), permissions: resolvePermissions(role) });

describe("registry", () => {
  it("has exactly the four approved templates, each structurally valid", () => {
    expect(WORKSPACE_TEMPLATE_IDS).toEqual(["distributor", "household-payroll", "baby-expense", "bridal-expense"]);
    for (const id of WORKSPACE_TEMPLATE_IDS) {
      expect(validateWorkspaceTemplate(WORKSPACE_TEMPLATES[id], CTX), id).toEqual([]);
    }
  });

  it("only Distributor is live; the other three are architected, not built", () => {
    expect(WORKSPACE_TEMPLATES.distributor.status).toBe("live");
    for (const id of NON_DISTRIBUTOR) expect(WORKSPACE_TEMPLATES[id].status).toBe("planned");
  });

  it("is frozen: nothing can be changed at runtime", () => {
    expect(() => {
      WORKSPACE_TEMPLATES.distributor.modules.push("x");
    }).toThrow();
    expect(() => {
      WORKSPACE_TEMPLATES["bridal-expense"].labels.modules.dashboard = "<b>x</b>";
    }).toThrow();
  });

  it("reuses existing module ids (no duplicates made for templates)", () => {
    for (const t of Object.values(WORKSPACE_TEMPLATES)) for (const m of t.modules) expect(getModule(m), `${t.id}/${m}`).not.toBeNull();
  });

  it("the validator rejects code, markup, unknown modules and planned ids that collide", () => {
    const ctx = CTX;
    const base = structuredClone(WORKSPACE_TEMPLATES["bridal-expense"]);
    const bad = (mutate) => {
      const t = structuredClone(base);
      mutate(t);
      return validateWorkspaceTemplate(t, ctx);
    };
    expect(bad((t) => (t.labels.modules.dashboard = "<script>alert(1)</script>"))).not.toEqual([]);
    expect(bad((t) => (t.labels.modules.dashboard = "x".repeat(41)))).not.toEqual([]);
    expect(bad((t) => (t.modules = [...t.modules, "teleport"]))).not.toEqual([]);
    expect(bad((t) => (t.navigation = [...t.navigation, "orders"]))).not.toEqual([]);
    expect(bad((t) => (t.dashboard.widgets = ["netSales"]))).not.toEqual([]); // needs orders, not allowed
    expect(bad((t) => (t.plannedModules = [{ id: "dashboard", name: "Dashboard" }]))).not.toEqual([]); // both planned and operational
    // unbuilt: can't be operational (even with a navigation slot)
    expect(bad((t) => ((t.modules = [...t.modules, "suppliers"]), (t.navigation = [...t.navigation, "suppliers"])))).toEqual(["module suppliers isn't built: list it in plannedModules until it is"]);
    expect(bad((t) => (t.settings.render = () => 1))).not.toEqual([]);
    expect(bad((t) => (t.css = "body{display:none}"))).not.toEqual([]);
    expect(bad((t) => (t.modules = t.modules.filter((m) => m !== "users")))).not.toEqual([]);
  });

  it("labels must be safe plain text", () => {
    for (const ok of ["Wedding Expenses", "Baby Dashboard", "Kasambahay Payroll", "Bride & Groom"]) expect(isSafeLabel(ok), ok).toBe(true);
    for (const no of ["<b>x</b>", "a\u0000b", " padded", "", "x".repeat(41), "javascript:alert(1)", null, 7]) expect(isSafeLabel(no), String(no)).toBe(false);
  });

  it("lookups accept only exact registered ids", () => {
    for (const id of [undefined, null, "", "Distributor", "distributor ", "__proto__", "constructor", "toString", "bridal", 1, ["distributor"]]) {
      expect(getWorkspaceTemplate(id), String(id)).toBeNull();
    }
  });
});

describe("planned modules are roadmap metadata only", () => {
  const planned = Object.values(WORKSPACE_TEMPLATES).flatMap((t) => t.plannedModules.map((p) => p.id));
  it("are registered modules the template hasn't activated, or unregistered future capabilities; never in navigation", () => {
    for (const t of Object.values(WORKSPACE_TEMPLATES)) {
      for (const p of t.plannedModules) {
        expect(t.modules, `${t.id}/${p.id}`).not.toContain(p.id);
        expect(t.navigation).not.toContain(p.id);
        if (!MODULE_IDS.includes(p.id)) expect(Object.keys(PERMISSIONS).some((k) => k.startsWith(`${p.id}.`)), p.id).toBe(false);
      }
    }
  });

  it("are never enabled in an entitlement snapshot, for any template, plan or add-on", () => {
    for (const id of WORKSPACE_TEMPLATE_IDS) {
      for (const planId of Object.keys(PLAN_SEED)) {
        const e = ent(id, planId);
        for (const p of WORKSPACE_TEMPLATES[id].plannedModules.map((x) => x.id)) expect(e.modules[p] === true, `${id}/${planId}/${p}`).toBe(false);
        for (const m of UNBUILT) expect(e.modules[m], `${id}/${planId}/${m}`).toBe(false);
      }
    }
  });

  it("an unbuilt module can't be switched on by an override (no add-on for planned modules)", () => {
    for (const m of UNBUILT) expect(() => ent("distributor", "pro", { modules: { [m]: true } }), m).toThrow(/isn't allowed/);
  });

  it("shipping module code alone activates nothing: an old snapshot's true for an unbuilt module never grants access", () => {
    const e = ent("distributor", "pro");
    const old = { ...e, modules: { ...e.modules, suppliers: true } };
    expect(isModuleEnabled(old, "suppliers")).toBe(false);
    // Built, but planned (not activated) for bridal: a forged true grants nothing.
    const b = ent("bridal-expense", "pro");
    expect(isModuleEnabled({ ...b, modules: { ...b.modules, expenses: true } }, "expenses")).toBe(false);
  });

  it("the future domains are recorded (payroll receipt confirmation, wedding tasks, guests/RSVP)", () => {
    const ids = (t) => WORKSPACE_TEMPLATES[t].plannedModules.map((p) => p.id);
    expect(ids("household-payroll")).toEqual(expect.arrayContaining(["household-staff", "payroll", "salary-payments", "receipt-confirmation"]));
    expect(ids("bridal-expense")).toEqual(expect.arrayContaining(["wedding-tasks", "guests", "rsvp", "wedding-suppliers"]));
    expect(ids("baby-expense")).toEqual(expect.arrayContaining(["baby-budget", "milestones"]));
  });
});

describe("plans and templates are independent dimensions", () => {
  it("no template id is a plan id or a plan+template combination", () => {
    for (const id of WORKSPACE_TEMPLATE_IDS) {
      expect(Object.keys(PLAN_SEED)).not.toContain(id);
      for (const plan of Object.keys(PLAN_SEED)) expect(id).not.toMatch(new RegExp(plan));
    }
  });

  it("every plan works with every template; limits and features come from the plan only", () => {
    for (const planId of Object.keys(PLAN_SEED)) {
      for (const t of WORKSPACE_TEMPLATE_IDS) {
        const e = ent(t, planId);
        expect(e).toMatchObject({ planId, workspaceTemplateId: t, workspaceTemplateVersion: WORKSPACE_TEMPLATES[t].version, limits: PLAN_SEED[planId].limits, features: PLAN_SEED[planId].features });
      }
    }
  });

  it("existing plan prices and limits are unchanged", () => {
    expect(PLAN_SEED.starter.pricing).toMatchObject({ setupFee: 499000, monthly: 99000 });
    expect(PLAN_SEED.growth.pricing).toMatchObject({ setupFee: 999000, monthly: 199000 });
    expect(PLAN_SEED.pro.pricing).toMatchObject({ setupFee: 1999000, monthly: 299000 });
    expect(PLAN_SEED.starter.limits.ordersPerMonth).toBe(500);
  });
});

describe("effective modules = core + (template allows ∩ (override ?? plan))", () => {
  it("Distributor: core + the built modules the plan includes; every unbuilt module false", () => {
    for (const planId of Object.keys(PLAN_SEED)) {
      const e = ent("distributor", planId);
      for (const id of MODULE_IDS) expect(e.modules[id], `${planId}/${id}`).toBe(CORE_MODULE_IDS.includes(id) || (BUILT.includes(id) && PLAN_SEED[planId].modules[id] === true));
      expect(Object.keys(e.modules).filter((k) => e.modules[k])).toEqual(["dashboard", "orders", "payments", "inventory", "customers", "reports", "expenses", "imports", "users", "settings"]);
    }
  });

  it("non-Distributor templates get no Distributor module, whatever the plan", () => {
    for (const t of NON_DISTRIBUTOR) {
      for (const planId of Object.keys(PLAN_SEED)) {
        const e = ent(t, planId);
        for (const m of DISTRIBUTOR_MODULES) expect(e.modules[m], `${t}/${planId}/${m}`).toBe(false);
        for (const m of CORE_MODULE_IDS) expect(e.modules[m]).toBe(true);
      }
    }
  });

  it("plan allowing Orders doesn't bypass the workspace; workspace allowing Orders doesn't bypass the plan", () => {
    expect(ent("bridal-expense", "pro").modules.orders).toBe(false);
    const noOrdersPlan = { ...structuredClone(PLAN_SEED.pro), id: "no-orders", modules: { ...PLAN_SEED.pro.modules, orders: false } };
    expect(computeEntitlements(noOrdersPlan, {}, "distributor").modules.orders).toBe(false);
  });

  it("an override can switch a module off", () => {
    expect(ent("distributor", "growth", { modules: { inventory: false } }).modules.inventory).toBe(false);
  });

  it("an override can't lift the template ceiling, and can't name unknown modules", () => {
    expect(() => ent("bridal-expense", "pro", { modules: { orders: true } })).toThrow(/isn't allowed in the bridal-expense workspace/);
    expect(() => ent("household-payroll", "pro", { modules: { expenses: true } })).toThrow(/isn't allowed/);
    expect(() => ent("distributor", "pro", { modules: { teleport: true } })).toThrow(/unknown module/);
    expect(() => ent("distributor", "pro", { modules: { "wedding-tasks": true } })).toThrow(/unknown module/);
  });

  it("a plan add-on within the template still works (Phase 4 behaviour kept)", () => {
    const lite = { ...structuredClone(PLAN_SEED.starter), id: "lite", modules: { ...PLAN_SEED.starter.modules, payments: false } };
    expect(computeEntitlements(lite, {}, "distributor").modules.payments).toBe(false);
    expect(computeEntitlements(lite, { modules: { payments: true } }, "distributor").modules.payments).toBe(true);
  });

  it("baby / bridal: Expenses is planned, so it's false in the snapshot (not merely unusable)", () => {
    for (const t of ["baby-expense", "bridal-expense"]) {
      expect(ent(t, "pro").modules.expenses).toBe(false);
      expect(WORKSPACE_TEMPLATES[t].plannedModules.map((p) => p.id)).toContain("expenses");
    }
  });

  it("there is no default template", () => {
    expect(() => computeEntitlements(PLAN_SEED.pro, {})).toThrow(/Unknown workspace template/);
    expect(() => computeEntitlements(PLAN_SEED.pro, {}, "")).toThrow();
    expect(() => computeEntitlements(PLAN_SEED.pro, {}, "Distributor")).toThrow();
  });
});

describe("stored snapshot validation fails closed", () => {
  const v = (s, planId, t) => validateEntitlementsSnapshot(s, planId, t);
  const good = () => ent("bridal-expense", "growth");

  it("a current snapshot for the business's template passes", () => {
    expect(v(good(), "growth", "bridal-expense")).toEqual({ ok: true, problems: [] });
    expect(good().schemaVersion).toBe(ENTITLEMENTS_SCHEMA_VERSION);
  });

  const cases = {
    "unknown template in snapshot": [(s) => (s.workspaceTemplateId = "florist"), "bridal-expense"],
    "malformed template in snapshot": [(s) => (s.workspaceTemplateId = { id: "bridal-expense" }), "bridal-expense"],
    "missing template in snapshot": [(s) => delete s.workspaceTemplateId, "bridal-expense"],
    "business has no template": [() => {}, undefined],
    "business template unknown": [() => {}, "florist"],
    "business template malformed": [() => {}, ["bridal-expense"]],
    "snapshot for another template (template changed)": [() => {}, "baby-expense"],
    "stale template version": [(s) => (s.workspaceTemplateVersion = 0), "bridal-expense"],
    "future template version": [(s) => (s.workspaceTemplateVersion = 2), "bridal-expense"],
    "version as a string": [(s) => (s.workspaceTemplateVersion = "1"), "bridal-expense"],
    "module beyond the template (forged)": [(s) => (s.modules.orders = true), "bridal-expense"],
    "unbuilt module enabled (old snapshot or forged)": [(s) => (s.modules.customers = true), "bridal-expense"],
    "unbuilt module enabled in a distributor snapshot": [(s) => (s.modules.reports = true), "bridal-expense"],
  };
  for (const [name, [mutate, businessTemplate]] of Object.entries(cases)) {
    it(name, () => {
      const s = good();
      mutate(s);
      expect(v(s, "growth", businessTemplate).ok).toBe(false);
    });
  }

  it("an unbuilt module switched on is rejected for being unbuilt (not only by the template ceiling)", () => {
    const s = ent("distributor", "growth");
    s.modules.suppliers = true;
    expect(v(s, "growth", "distributor").problems).toContain("module suppliers isn't built and can't be enabled");
  });

  it("older distributor snapshots are stale; the previous version only during a rollout window", () => {
    const s = ent("distributor", "growth");
    expect(s.workspaceTemplateVersion).toBe(5);
    for (const old of [1, 2, 3]) expect(v({ ...s, workspaceTemplateVersion: old }, "growth", "distributor").ok).toBe(false);
    expect(v({ ...s, workspaceTemplateVersion: 4 }, "growth", "distributor").ok).toBe((WORKSPACE_TEMPLATES.distributor.upgradingFrom ?? []).includes(4));
  });

  it("a distributor snapshot that lost only its template id is not read as distributor", () => {
    const s = ent("distributor", "growth");
    delete s.workspaceTemplateId; // version 1 and schemaVersion 2 intact
    expect(v(s, "growth", "distributor").ok).toBe(false);
    expect(v({ ...s, workspaceTemplateId: null }, "growth", "distributor").ok).toBe(false);
  });

  it("legacy schemaVersion 1 (pre-8.5) is rejected now that the migration is done", () => {
    const legacy = ent("distributor", "growth");
    legacy.schemaVersion = 1;
    delete legacy.workspaceTemplateId;
    delete legacy.workspaceTemplateVersion;
    expect(v(legacy, "growth", undefined).ok).toBe(false);
    expect(v(legacy, "growth", "distributor").ok).toBe(false); // assigned business must be current
    expect(v({ ...legacy, workspaceTemplateId: "distributor" }, "growth", undefined).ok).toBe(false);
    expect(snapshotWorkspaceTemplateId(legacy)).toBeNull();
  });
});

describe("module access re-checks the workspace", () => {
  it("a forged session/snapshot can't carry Orders into a bridal workspace", () => {
    const e = ent("bridal-expense", "pro");
    const forged = { ...e, modules: { ...e.modules, orders: true, inventory: true, payments: true } };
    for (const m of ["orders", "inventory", "payments"]) {
      expect(isModuleEnabled(forged, m)).toBe(false);
      expect(canUseModule({ entitlements: forged, permissions: resolvePermissions("owner") }, m)).toBe(false);
    }
  });

  it("Orders permission alone doesn't grant Orders when the workspace disables it", () => {
    const perms = resolvePermissions("owner");
    expect(perms["orders.view"]).toBe(true);
    expect(canUseModule({ entitlements: ent("household-payroll"), permissions: perms }, "orders")).toBe(false);
  });

  it("unknown or missing workspace: nothing", () => {
    const e = { ...ent("distributor"), workspaceTemplateId: "florist" };
    expect(isModuleEnabled(e, "orders")).toBe(false);
    expect(resolveNavigation({ entitlements: e, permissions: resolvePermissions("owner") })).toEqual([]);
    expect(resolveDashboard({ entitlements: e, permissions: resolvePermissions("owner") })).toEqual([]);
    expect(workspaceAllowsModule(undefined, "dashboard")).toBe(false);
  });
});

describe("navigation", () => {
  const nav = (t, role) => resolveNavigation(access(t, role)).map((m) => `${m.path} ${m.label}`);

  it("Distributor: unchanged order and labels for every role", () => {
    // Reports and Imports placeholders return when each is built; Customers
    // is back since Phase 9 (distributor v2).
    // Expenses (Phase 10) is labelled "Operating Expenses" for Distributor;
    // Staff hold no expenses.* permission, so they don't see it.
    expect(nav("distributor", "owner")).toEqual(["/ Dashboard", "/orders Orders", "/payments Payments", "/inventory Inventory", "/customers Customers", "/expenses Operating Expenses", "/reports Reports", "/imports Imports", "/users Users", "/settings Settings"]);
    expect(nav("distributor", "staff")).toEqual(["/ Dashboard", "/orders Orders", "/payments Payments", "/inventory Inventory", "/customers Customers"]);
    expect(nav("distributor", "manager")).toEqual(["/ Dashboard", "/orders Orders", "/payments Payments", "/inventory Inventory", "/customers Customers", "/expenses Operating Expenses", "/reports Reports", "/imports Imports", "/users Users", "/settings Settings"]);
  });

  it("non-Distributor workspaces get no Distributor navigation, and their own names", () => {
    expect(nav("bridal-expense", "owner")).toEqual(["/ Wedding Dashboard", "/users Users", "/settings Settings"]);
    expect(nav("baby-expense", "owner")).toEqual(["/ Baby Dashboard", "/users Users", "/settings Settings"]);
    expect(nav("household-payroll", "owner")).toEqual(["/ Payroll Dashboard", "/users Users", "/settings Settings"]);
  });

  it("roles still differ inside a workspace (staff: no Users/Settings)", () => {
    expect(nav("bridal-expense", "staff")).toEqual(["/ Wedding Dashboard"]);
  });

  it("labels never change ids, paths or permissions", () => {
    const m = resolveNavigation(access("bridal-expense"))[0];
    expect(m).toMatchObject({ id: "dashboard", path: "/", permission: "dashboard.view", label: "Wedding Dashboard" });
  });
});

describe("dashboard", () => {
  const ids = (t, role = "owner") => resolveDashboard(access(t, role)).map((w) => w.id);

  it("Distributor: selected-period widgets first, then current operations (Phase 12.5 adds COGS)", () => {
    expect(ids("distributor")).toEqual(["netSales", "cogs", "grossProfit", "operatingExpenses", "estimatedOperatingProfit", "paymentsReceived", "ordersToday", "receivablesOutstanding", "unpaidOrders", "pendingFulfillment", "lowStock", "recentOrders", "lowStockItems", "recentActivity"]);
    expect(ids("distributor", "staff")).toEqual(["ordersToday", "unpaidOrders", "pendingFulfillment", "lowStock", "recentOrders", "lowStockItems", "recentActivity"]);
  });

  it("non-Distributor: no widgets, so no metric document or list is ever requested", () => {
    for (const t of NON_DISTRIBUTOR) {
      expect(ids(t)).toEqual([]);
      expect(dashboardDocuments(resolveDashboard(access(t)), "2026-10-08")).toEqual([]);
      expect(dashboardEmptyState(ent(t)).title).toMatch(/being prepared/);
    }
  });
});
