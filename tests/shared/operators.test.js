// Phase 17: operator rules (who is an operator, what can be created, which
// modules can be overridden and how "effective" is worked out) and tenant
// configuration (controlled terms, fail-safe defaults).

import { describe, it, expect } from "vitest";
import { isActiveOperator, creatableWorkspaces, validateCreateBusinessInput, overridableModules, overrideChange, moduleTable, validateReason, validateSubscriptionStatus } from "../../shared/operators.js";
import { resolveTenantConfig, validateTerminologyChange, terminologyLabels, termsFor, TENANT_CONFIG_VERSION } from "../../shared/tenant-config.js";
import { PLAN_SEED } from "../../shared/plans.seed.js";
import { computeEntitlements } from "../../shared/entitlements.js";
import { WORKSPACE_TEMPLATES } from "../../shared/workspaces.js";

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
};

describe("operators", () => {
  it("only an active record with a known role is an operator", () => {
    expect(isActiveOperator({ role: "superadmin", status: "active" })).toBe(true);
    for (const r of [null, {}, { role: "superadmin", status: "disabled" }, { role: "owner", status: "active" }, { role: "__proto__", status: "active" }]) expect(isActiveOperator(r), JSON.stringify(r)).toBe(false);
  });

  it("creatable workspaces = the live templates at their CURRENT versions (never typed, never obsolete)", () => {
    expect(creatableWorkspaces()).toEqual(Object.values(WORKSPACE_TEMPLATES).filter((t) => t.status === "live").map((t) => ({ id: t.id, name: t.name, version: t.version })));
    expect(creatableWorkspaces().find((w) => w.id === "bridal-expense").version).toBe(2);
  });

  it("create input: slug id, live workspace, plan id, owner email, real timezone; nothing else accepted", () => {
    const ok = { name: "ABC", businessId: "abc-trading", workspaceTemplateId: "distributor", planId: "growth", ownerEmail: " Abe@ABC.test ", ownerName: "Abe", timezone: "Asia/Manila" };
    expect(validateCreateBusinessInput(ok).ownerEmail).toBe("abe@abc.test");
    for (const bad of [{ businessId: "ABC" }, { businessId: "a/b" }, { workspaceTemplateId: "retail" }, { planId: "Gold!" }, { ownerEmail: "x" }, { timezone: "Mars/Base" }, { entitlements: {} }]) expect(code(() => validateCreateBusinessInput({ ...ok, ...bad })), JSON.stringify(bad)).toBe("invalid-input");
  });

  it("overridable = the workspace's own built, non-core modules (never another workspace's)", () => {
    expect(overridableModules("distributor")).toEqual(["orders", "payments", "inventory", "customers", "expenses", "reports", "imports"]);
    expect(overridableModules("household-payroll")).toEqual(["household", "attendance", "payroll", "advances"]);
    expect(overridableModules("nope")).toEqual([]);
    expect(code(() => overrideChange("distributor", "payroll", "enabled"))).toBe("not-overridable");
    expect(code(() => overrideChange("distributor", "users", "disabled"))).toBe("not-overridable");
    expect(code(() => overrideChange("distributor", "suppliers", "enabled"))).toBe("not-overridable");
    expect(code(() => overrideChange("distributor", "imports", "maybe"))).toBe("invalid-input");
    expect(overrideChange("distributor", "imports", "disabled")).toEqual({ set: { modules: { imports: false } }, clear: {} });
    expect(overrideChange("distributor", "imports", "default")).toEqual({ set: {}, clear: { modules: ["imports"] } });
  });

  it("effective = template && (override Enabled || (plan && not Disabled)) && built; matches the computed snapshot", () => {
    const plan = { ...PLAN_SEED.starter, modules: { ...PLAN_SEED.starter.modules, imports: false } };
    for (const overrides of [{}, { imports: true }, { reports: false }]) {
      const snap = computeEntitlements(plan, { modules: overrides }, "distributor");
      for (const row of moduleTable({ templateId: "distributor", plan, overrides, snapshot: snap })) expect(row.computed, `${JSON.stringify(overrides)} ${row.id}`).toBe(row.effective);
    }
    const t = moduleTable({ templateId: "distributor", plan, overrides: { imports: true } });
    expect(t.find((r) => r.id === "imports")).toMatchObject({ template: true, plan: false, override: true, computed: true, editable: true });
    expect(t.find((r) => r.id === "payroll")).toMatchObject({ template: false, computed: false, editable: false });
  });

  it("reasons and statuses", () => {
    expect(code(() => validateReason("ok"))).toBe("reason-required");
    expect(validateReason("  Client  paid ")).toBe("Client paid");
    expect(code(() => validateSubscriptionStatus("deleted"))).toBe("invalid-input");
  });
});

describe("tenant configuration", () => {
  it("missing / old / unknown values resolve to safe defaults (cosmetic: never fail closed)", () => {
    for (const doc of [null, {}, { terminology: { customer: "<script>" } }, { version: 99, terminology: { customer: 5 } }]) expect(resolveTenantConfig(doc, "distributor").terminology.customer, JSON.stringify(doc)).toMatchObject({ choice: "customer", plural: "Customers" });
    expect(resolveTenantConfig({ terminology: { customer: "dealer" } }, "distributor")).toEqual({ version: TENANT_CONFIG_VERSION, terminology: { customer: { choice: "dealer", singular: "Dealer", plural: "Dealers" } } });
  });
  it("terms only exist for their workspace; changes must use listed options", () => {
    expect(termsFor("baby-expense")).toEqual([]);
    expect(resolveTenantConfig({ terminology: { customer: "dealer" } }, "baby-expense").terminology).toEqual({});
    expect(() => validateTerminologyChange("baby-expense", { customer: "dealer" })).toThrow();
    expect(() => validateTerminologyChange("distributor", { customer: "Dealer!!" })).toThrow();
    expect(() => validateTerminologyChange("distributor", {})).toThrow();
    expect(validateTerminologyChange("distributor", { customer: "reseller" })).toEqual({ customer: "reseller" });
  });
  it("labels relabel the module only (customers -> Dealers)", () => {
    expect(terminologyLabels(resolveTenantConfig({ terminology: { customer: "dealer" } }, "distributor"))).toEqual({ customers: "Dealers" });
    expect(terminologyLabels(undefined)).toEqual({});
  });
});
