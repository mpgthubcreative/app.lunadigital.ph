// Module registry: the one list of everything Luna can show in a tenant's
// navigation, and which data each module owns: `collections` maps each
// Firestore collection to the permission that reads it; `storage` does the
// same for Storage areas.
//
// A user may use a module only when ALL of these hold (canUseModule):
//   1. the module is available (built) in this version of Luna
//   2. the business's effective entitlements say modules[id] === true
//      (plan/override within the workspace template, shared/entitlements.js)
//   3. the snapshot's workspace template allows the module (checked again
//      here, so a snapshot can never carry a module past its template)
//   4. the user holds the module's permission (=== true)
// Workspace templates (shared/workspaces.js) also order and label the
// navigation; labels are display text only.
// The server applies the same test in requireTenant(), and the Firestore /
// Storage rules apply it to the module's `collections` / `storage` areas.
// tests/shared/rules-registry.test.js fails if the rules drift from this file.
//
// Core modules (dashboard, users, settings) are part of every package:
// computeEntitlements always sets them true and overrides can't remove
// them. They are still checked like any other module, so a missing or
// malformed snapshot fails closed for them too.

import { snapshotWorkspaceTemplateId, workspaceAllowsModule, getWorkspaceTemplate, workspaceModuleLabel } from "./workspaces.js";

export const MODULES = Object.freeze([
  { id: "dashboard", label: "Dashboard", path: "/", icon: "dashboard", permission: "dashboard.view", available: true, core: true, collections: { metrics: "dashboard.view", financialMetrics: "dashboard.financials", orderCosts: "dashboard.financials", inbox: "notifications.view", inboxState: "notifications.view" }, storage: {} },
  { id: "orders", label: "Orders", path: "/orders", icon: "orders", permission: "orders.view", available: true, collections: { orders: "orders.view" }, storage: {} },
  { id: "payments", label: "Payments", path: "/payments", icon: "payments", permission: "payments.view", available: true, collections: { payments: "payments.view" }, storage: { payments: "payments.view" } },
  { id: "inventory", label: "Inventory", path: "/inventory", icon: "inventory", permission: "inventory.view", available: true, collections: { products: "inventory.view", inventoryTransactions: "inventory.view", productCosts: "inventory.costs", inventoryTransactionCosts: "inventory.costs" }, storage: { products: "inventory.view" } },
  // Built in Phase 9 (Distributor customers).
  { id: "customers", label: "Customers", path: "/customers", icon: "customers", permission: "customers.view", available: true, collections: { customers: "customers.view" }, storage: {} },
  // Built in Phase 11 (Distributor reports; server-aggregated via
  // GET /api/reports).
  { id: "reports", label: "Reports", path: "/reports", icon: "reports", permission: "reports.view", available: true, collections: { reports: "reports.view" }, storage: { exports: "reports.export" } },
  // Built in Phase 10 (operating expenses). Operational only where a
  // workspace template lists it (Distributor v3); others keep it planned.
  { id: "expenses", label: "Expenses", path: "/expenses", icon: "expenses", permission: "expenses.view", available: true, collections: { expenses: "expenses.view" }, storage: {} },
  // Built in Phase 12 (Distributor Products + Customers imports).
  { id: "imports", label: "Imports", path: "/imports", icon: "imports", permission: "imports.run", available: true, collections: { imports: "imports.run" }, storage: { imports: "imports.run" } },
  // Built in Phase 14 (Household / Kasambahay Payroll). Operational only in
  // the household-payroll template.
  { id: "household", label: "Household Staff", path: "/household-staff", icon: "staff", permission: "household.view", available: true, collections: { householdStaff: "household.view" }, storage: {} },
  { id: "attendance", label: "Attendance", path: "/attendance", icon: "calendar", permission: "attendance.view", available: true, collections: { attendance: "attendance.view" }, storage: {} },
  { id: "payroll", label: "Payroll", path: "/payroll", icon: "payroll", permission: "payroll.view", available: true, collections: { payrolls: "payroll.view" }, storage: {} },
  { id: "advances", label: "Advances", path: "/advances", icon: "advance", permission: "advances.view", available: true, collections: { advances: "advances.view" }, storage: {} },
  { id: "users", label: "Users", path: "/users", icon: "users", permission: "users.view", available: true, core: true, collections: { members: "users.view" }, storage: {} },
  { id: "settings", label: "Settings", path: "/settings", icon: "settings", permission: "settings.view", available: true, core: true, collections: { settings: "settings.view" }, storage: {} },

  // Known future modules: may be referenced by business configuration
  // today, but never navigable until built.
  { id: "suppliers", label: "Suppliers", path: "/suppliers", icon: "suppliers", permission: "inventory.view", available: false, collections: {}, storage: {} },
  { id: "production", label: "Production", path: "/production", icon: "production", permission: "inventory.view", available: false, collections: {}, storage: {} },
  { id: "returns", label: "Returns", path: "/returns", icon: "returns", permission: "orders.view", available: false, collections: {}, storage: {} },
]);

export const MODULE_IDS = Object.freeze(MODULES.map((m) => m.id));
// Modules registered in the CURRENT release whose snapshot key may still be
// missing from snapshots computed before it (staged rollout, see
// docs/ARCHITECTURE.md "Activating a module"): a missing key reads as false.
// Emptied once recompute-entitlements has run everywhere.
export const ROLLING_OUT_MODULE_IDS = Object.freeze(["household", "attendance", "payroll", "advances"]);
export const CORE_MODULE_IDS = Object.freeze(MODULES.filter((m) => m.core).map((m) => m.id));
// Modules a plan or override can switch on or off.
export const SELLABLE_MODULE_IDS = Object.freeze(MODULES.filter((m) => !m.core).map((m) => m.id));

export function getModule(id) {
  return MODULES.find((m) => m.id === id) || null;
}

// Is the module built, allowed by the snapshot's workspace template AND
// switched on in it? Exact `true` only: "true", 1 or a missing key all
// mean off; an unknown or missing workspace means off.
export function isModuleEnabled(entitlements, moduleId) {
  const mod = getModule(moduleId);
  if (!mod || !mod.available) return false;
  const modules = entitlements && entitlements.modules;
  if (!modules || typeof modules !== "object" || modules[moduleId] !== true) return false;
  return workspaceAllowsModule(snapshotWorkspaceTemplateId(entitlements), moduleId);
}

// Entitled module + the module's permission.
export function canUseModule({ entitlements, permissions }, moduleId) {
  const mod = getModule(moduleId);
  return Boolean(mod) && isModuleEnabled(entitlements, moduleId) && Boolean(permissions) && permissions[mod.permission] === true;
}

// Usable modules in the workspace's navigation order, with its labels.
export function resolveNavigation({ entitlements, permissions }) {
  const templateId = snapshotWorkspaceTemplateId(entitlements);
  const template = getWorkspaceTemplate(templateId);
  if (!template) return [];
  return template.navigation
    .filter((id) => canUseModule({ entitlements, permissions }, id))
    .map((id) => {
      const mod = getModule(id);
      return { ...mod, label: workspaceModuleLabel(templateId, id, mod.label) };
    });
}
