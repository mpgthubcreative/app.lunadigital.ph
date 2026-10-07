// Module registry — the one list of everything Luna can show in a tenant's
// navigation. A module appears for a user only when ALL of these hold:
//   1. it is available (built) in this version of Luna
//   2. the business's effective entitlements enable it (plan + overrides)
//   3. the user holds the module's view permission
// See resolveNavigation(). No industry-specific dashboards: one registry,
// configured per business.

export const MODULES = Object.freeze([
  { id: "dashboard", label: "Dashboard", path: "/", icon: "dashboard", permission: "dashboard.view", available: true, core: true },
  { id: "orders", label: "Orders", path: "/orders", icon: "orders", permission: "orders.view", available: true },
  { id: "payments", label: "Payments", path: "/payments", icon: "payments", permission: "payments.view", available: true },
  { id: "inventory", label: "Inventory", path: "/inventory", icon: "inventory", permission: "inventory.view", available: true },
  { id: "customers", label: "Customers", path: "/customers", icon: "customers", permission: "customers.view", available: true },
  { id: "reports", label: "Reports", path: "/reports", icon: "reports", permission: "reports.view", available: true },
  { id: "imports", label: "Imports", path: "/imports", icon: "imports", permission: "imports.run", available: true },
  { id: "users", label: "Users", path: "/users", icon: "users", permission: "users.view", available: true, core: true },
  { id: "settings", label: "Settings", path: "/settings", icon: "settings", permission: "settings.view", available: true, core: true },

  // Known future modules: may be referenced by business configuration
  // today, but never navigable until built.
  { id: "suppliers", label: "Suppliers", path: "/suppliers", icon: "suppliers", permission: "inventory.view", available: false },
  { id: "production", label: "Production", path: "/production", icon: "production", permission: "inventory.view", available: false },
  { id: "returns", label: "Returns", path: "/returns", icon: "returns", permission: "orders.view", available: false },
]);

export const MODULE_IDS = Object.freeze(MODULES.map((m) => m.id));

export function getModule(id) {
  return MODULES.find((m) => m.id === id) || null;
}

// Core modules are always part of the product (you can't sell a business
// a Luna without a dashboard or settings); plan entitlements only govern
// the non-core ones.
export function isModuleEnabled(entitlements, moduleId) {
  const mod = getModule(moduleId);
  if (!mod || !mod.available) return false;
  if (mod.core) return true;
  return Boolean(entitlements && entitlements.modules && entitlements.modules[moduleId] === true);
}

export function resolveNavigation({ entitlements, permissions }) {
  return MODULES.filter(
    (mod) => isModuleEnabled(entitlements, mod.id) && Boolean(permissions) && permissions[mod.permission] === true
  );
}
