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
import { MODULES, MODULE_IDS, CORE_MODULE_IDS, ROLLING_OUT_MODULE_IDS, getModule, isModuleEnabled, canUseModule, resolveNavigation } from "../../shared/modules.js";
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

  it("every workspace is live: Distributor, (14) Household Payroll, (15) Baby, (16) Bridal", () => {
    for (const t of ["distributor", "household-payroll", "baby-expense", "bridal-expense"]) expect(WORKSPACE_TEMPLATES[t].status, t).toBe("live");
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
    // Built, but not in the household template: a forged true grants nothing.
    const h = ent("household-payroll", "pro");
    expect(isModuleEnabled({ ...h, modules: { ...h.modules, expenses: true } }, "expenses")).toBe(false);
  });

  it("the future domains are recorded (payroll receipt confirmation, wedding tasks, guests/RSVP)", () => {
    const ids = (t) => WORKSPACE_TEMPLATES[t].plannedModules.map((p) => p.id);
    // Phase 14 built Household Staff, Attendance, Payroll (incl. salary payments,
    // receipt confirmation, deductions, history) and Advances; Reports stay planned.
    expect(ids("household-payroll")).toEqual(["payroll-reports"]);
    expect(WORKSPACE_TEMPLATES["household-payroll"].modules).toEqual(["dashboard", "users", "settings", "household", "attendance", "payroll", "advances"]);
    // Phase 16 built Wedding Budget / Expenses / Suppliers / Supplier Payments / Tasks / Guests & RSVP.
    expect(ids("bridal-expense")).toEqual(["wedding-reports"]);
    expect(WORKSPACE_TEMPLATES["bridal-expense"].modules).toEqual(["dashboard", "users", "settings", "expenses", "budget", "vendors", "vendorpayments", "tasks", "guests"]);
    // Phase 15 built Baby Expenses, Budget & Categories, Payment Schedule and Providers.
    expect(ids("baby-expense")).toEqual(["milestones", "baby-reports"]);
    expect(WORKSPACE_TEMPLATES["baby-expense"].modules).toEqual(["dashboard", "users", "settings", "expenses", "budget", "schedule", "providers"]);
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
      for (const id of MODULE_IDS) expect(e.modules[id], `${planId}/${id}`).toBe(CORE_MODULE_IDS.includes(id) || (BUILT.includes(id) && WORKSPACE_TEMPLATES.distributor.modules.includes(id) && PLAN_SEED[planId].modules[id] === true));
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

  it("Household Payroll modules exist in code but only the household-payroll workspace gets them (Distributor, Baby, Bridal never)", () => {
    const HOUSEHOLD = ["household", "attendance", "payroll", "advances"];
    for (const t of ["distributor", "baby-expense", "bridal-expense"]) {
      for (const planId of Object.keys(PLAN_SEED)) for (const m of HOUSEHOLD) expect(ent(t, planId).modules[m], `${t}/${planId}/${m}`).toBe(false);
      for (const m of HOUSEHOLD) expect(() => ent(t, "pro", { modules: { [m]: true } }), `${t}/${m}`).toThrow(/isn't allowed/);
    }
    for (const m of HOUSEHOLD) expect(ent("household-payroll", "growth").modules[m]).toBe(true);
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

  it("household: Expenses isn't in the template, so it's false in the snapshot; Baby (15) and Bridal (16) have it", () => {
    expect(ent("household-payroll", "pro").modules.expenses).toBe(false);
    expect(ent("bridal-expense", "pro").modules.expenses).toBe(true);
    const baby = ent("baby-expense", "pro").modules;
    for (const m of ["expenses", "budget", "schedule", "providers"]) expect(baby[m], m).toBe(true);
    for (const m of ["orders", "payments", "inventory", "customers", "reports", "imports", "household", "attendance", "payroll", "advances"]) expect(baby[m], m).toBe(false);
  });

  it("Baby-only modules never reach Distributor, Household Payroll or Bridal snapshots (budget is the shared primitive: Bridal has it, Phase 16)", () => {
    for (const t of ["distributor", "household-payroll"]) for (const m of ["budget", "schedule", "providers"]) expect(ent(t, "pro").modules[m], `${t}/${m}`).toBe(false);
    for (const m of ["schedule", "providers"]) expect(ent("bridal-expense", "pro").modules[m], m).toBe(false);
    expect(ent("bridal-expense", "pro").modules.budget).toBe(true);
  });

  it("Phase 16: Bridal gets Wedding Expenses, Budget, Suppliers, Supplier Payments, Tasks, Guests; nobody else gets the Wedding modules", () => {
    const b = ent("bridal-expense", "pro").modules;
    for (const m of ["expenses", "budget", "vendors", "vendorpayments", "tasks", "guests"]) expect(b[m], m).toBe(true);
    for (const m of ["orders", "payments", "inventory", "customers", "reports", "imports", "household", "attendance", "payroll", "advances", "schedule", "providers", "suppliers"]) expect(b[m], m).toBe(false);
    for (const t of ["distributor", "household-payroll", "baby-expense"]) for (const m of ["vendors", "vendorpayments", "tasks", "guests"]) expect(ent(t, "pro").modules[m], `${t}/${m}`).toBe(false);
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
    "future template version": [(s) => (s.workspaceTemplateVersion = 3), "bridal-expense"],
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

  it("Phase 14 strict: household-payroll v2 is the only accepted version; stale or malformed snapshots fail closed", () => {
    expect(WORKSPACE_TEMPLATES["household-payroll"].upgradingFrom).toBeUndefined();
    const s = ent("household-payroll", "growth");
    expect(s.workspaceTemplateVersion).toBe(2);
    expect(v(s, "growth", "household-payroll")).toEqual({ ok: true, problems: [] });
    for (const bad of [1, 0, 3, 99, "2", null, 2.5]) expect(v({ ...s, workspaceTemplateVersion: bad }, "growth", "household-payroll").ok, String(bad)).toBe(false);
    const noVersion = structuredClone(s);
    delete noVersion.workspaceTemplateVersion;
    expect(v(noVersion, "growth", "household-payroll").ok).toBe(false);
    // a pre-Phase-14 snapshot (no household keys) is stale now, for every template
    for (const t of ["household-payroll", "distributor", "baby-expense", "bridal-expense"]) {
      const old = structuredClone(ent(t, "growth"));
      for (const k of ["household", "attendance", "payroll", "advances"]) delete old.modules[k];
      expect(v(old, "growth", t).ok, t).toBe(false);
    }
  });

  it("Phase 15 strict: baby-expense v2 is the only accepted version; stale or malformed snapshots fail closed", () => {
    expect(WORKSPACE_TEMPLATES["baby-expense"].upgradingFrom).toBeUndefined();
    const s = ent("baby-expense", "growth");
    expect(s.workspaceTemplateVersion).toBe(2);
    expect(v(s, "growth", "baby-expense")).toEqual({ ok: true, problems: [] });
    for (const bad of [1, 0, 3, 99, "2", null, 2.5]) expect(v({ ...s, workspaceTemplateVersion: bad }, "growth", "baby-expense").ok, String(bad)).toBe(false);
    const noVersion = structuredClone(s);
    delete noVersion.workspaceTemplateVersion;
    expect(v(noVersion, "growth", "baby-expense").ok).toBe(false);
    // each Baby key is required, as a boolean, in every template's snapshot
    for (const t of ["baby-expense", "distributor", "household-payroll", "bridal-expense"]) {
      for (const k of ["budget", "schedule", "providers"]) {
        const missing = structuredClone(ent(t, "growth"));
        delete missing.modules[k];
        expect(v(missing, "growth", t).ok, `${t} missing ${k}`).toBe(false);
        const notBool = structuredClone(ent(t, "growth"));
        notBool.modules[k] = "true";
        expect(v(notBool, "growth", t).ok, `${t} ${k}="true"`).toBe(false);
      }
    }
  });

  it("Phase 15 strict: Baby modules forged into Distributor, Household or Bridal snapshots are refused", () => {
    for (const t of ["distributor", "household-payroll", "bridal-expense"]) {
      // (Bridal legitimately has the shared budget primitive since Phase 16.)
      for (const m of t === "bridal-expense" ? ["schedule", "providers"] : ["budget", "schedule", "providers"]) {
        const s = structuredClone(ent(t, "growth"));
        s.modules[m] = true;
        expect(v(s, "growth", t).ok, `${t}/${m}`).toBe(false);
      }
      expect(v(ent(t, "growth"), "growth", t).ok, t).toBe(true);
    }
  });

  it("Phase 16 strict: bridal-expense v2 is the only accepted version; stale, malformed or keyless snapshots fail closed", () => {
    expect(ROLLING_OUT_MODULE_IDS).toEqual([]);
    expect(WORKSPACE_TEMPLATES["bridal-expense"].upgradingFrom).toBeUndefined();
    const s = ent("bridal-expense", "growth");
    expect(s.workspaceTemplateVersion).toBe(2);
    expect(v(s, "growth", "bridal-expense")).toEqual({ ok: true, problems: [] });
    for (const bad of [1, 0, 3, 99, "2", null, 2.5]) expect(v({ ...s, workspaceTemplateVersion: bad }, "growth", "bridal-expense").ok, String(bad)).toBe(false);
    const noVersion = structuredClone(s);
    delete noVersion.workspaceTemplateVersion;
    expect(v(noVersion, "growth", "bridal-expense").ok).toBe(false);
    // each Wedding key is required, as a boolean, in every template's snapshot
    for (const t of ["bridal-expense", "distributor", "household-payroll", "baby-expense"]) {
      for (const k of ["vendors", "vendorpayments", "tasks", "guests"]) {
        const missing = structuredClone(ent(t, "growth"));
        delete missing.modules[k];
        expect(v(missing, "growth", t).ok, `${t} missing ${k}`).toBe(false);
        const notBool = structuredClone(ent(t, "growth"));
        notBool.modules[k] = "true";
        expect(v(notBool, "growth", t).ok, `${t} ${k}="true"`).toBe(false);
      }
    }
  });

  it("Phase 16 strict: Wedding modules forged into Distributor, Household or Baby are refused", () => {
    for (const t of ["distributor", "household-payroll", "baby-expense"]) {
      for (const m of ["vendors", "vendorpayments", "tasks", "guests"]) {
        const s = structuredClone(ent(t, "growth"));
        s.modules[m] = true;
        expect(v(s, "growth", t).ok, `${t}/${m}`).toBe(false);
      }
    }
  });

  it("Phase 14 strict: Household modules forged into Distributor, Baby or Bridal snapshots are refused", () => {
    for (const t of ["distributor", "baby-expense", "bridal-expense"]) {
      for (const m of ["household", "attendance", "payroll", "advances"]) {
        const s = structuredClone(ent(t, "growth"));
        s.modules[m] = true;
        expect(v(s, "growth", t).ok, `${t}/${m}`).toBe(false);
      }
      expect(v(ent(t, "growth"), "growth", t).ok, t).toBe(true);
    }
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
    // Phase 18.5: the wedding story order (Tasks → Guests → Suppliers → Payments → Budget / Expenses).
    expect(nav("bridal-expense", "owner")).toEqual(["/ Wedding Dashboard", "/wedding-tasks Wedding Tasks", "/guests Guests & RSVP", "/wedding-suppliers Wedding Suppliers", "/supplier-payments Supplier Payments", "/budget Wedding Budget", "/expenses Wedding Expenses", "/users Users", "/settings Settings"]);
    expect(nav("baby-expense", "owner")).toEqual(["/ Baby Dashboard", "/budget Budget & Categories", "/expenses Baby Expenses", "/payment-schedule Payment Schedule", "/providers Providers / Vendors", "/users Users", "/settings Settings"]);
    expect(nav("household-payroll", "owner")).toEqual(["/ Payroll Dashboard", "/attendance Attendance", "/payroll Payroll", "/advances Advances", "/household-staff Household Staff", "/users Users", "/settings Settings"]);
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

  it("Distributor (Phase 18.5): the store pulse; profitability (COGS, gross / operating profit) lives in Reports only", () => {
    expect(ids("distributor")).toEqual(["netSales", "ordersToday", "fulfilledOrders", "receivablesOutstanding", "unpaidOrders", "pendingFulfillment", "lowStock", "paymentsToVerify", "ordersPending", "ordersPreparing", "ordersReady", "inventorySummary", "recentOrders", "lowStockItems"]);
    for (const id of ["cogs", "grossProfit", "operatingExpenses", "estimatedOperatingProfit", "paymentsReceived"]) expect(ids("distributor")).not.toContain(id);
    expect(ids("distributor", "staff")).toEqual(["ordersToday", "fulfilledOrders", "unpaidOrders", "pendingFulfillment", "lowStock", "paymentsToVerify", "ordersPending", "ordersPreparing", "ordersReady", "inventorySummary", "recentOrders", "lowStockItems"]);
  });

  it("Household Payroll: its own lists + a live active-staff count, never a metric document", () => {
    expect(ids("household-payroll")).toEqual(["activeStaff", "attendanceToday", "payrollsToRelease", "awaitingReceipt", "advancesNotPaid", "advancesToDeduct"]);
    expect(dashboardDocuments(resolveDashboard(access("household-payroll")), "2026-10-08")).toEqual([]);
  });

  it("Bridal (Phase 16): only Wedding widgets; reads spendingMetrics, budgets, taskTotals, guestTotals (+ a live overdue count), never a Distributor or Baby widget", () => {
    expect(ids("bridal-expense")).toEqual(["weddingSpent", "weddingSupplierPaid", "weddingExpenseCount", "weddingBudgetTotal", "weddingSpentNow", "weddingRemaining", "weddingSupplierBalance", "weddingUpcoming", "weddingOpenTasks", "weddingOverdueTasks", "weddingConfirmedGuests", "weddingAwaitingRsvp", "upcomingSupplierPayments", "tasksDueSoon", "recentWeddingExpenses", "rsvpSummary", "supplierSummary"]);
    const cols = dashboardDocuments(resolveDashboard(access("bridal-expense")), "2026-10-08").map((d) => d.collection);
    expect([...new Set(cols)].sort()).toEqual(["budgets", "guestTotals", "spendingMetrics", "taskTotals"]);
    expect(dashboardEmptyState(ent("bridal-expense")).title).toMatch(/ready/);
  });

  it("Baby (Phase 15): only Baby widgets; reads spendingMetrics + budgets/current, never a Distributor metric", () => {
    expect(ids("baby-expense")).toEqual(["babySpent", "babyExpenseCount", "budgetTotal", "budgetSpent", "budgetRemaining", "budgetUpcoming", "spendingByCategory", "upcomingPayments", "recentExpenses"]);
    const cols = dashboardDocuments(resolveDashboard(access("baby-expense")), "2026-10-08").map((d) => d.collection);
    expect(cols.sort()).toEqual(["budgets", "spendingMetrics"]);
  });
});
