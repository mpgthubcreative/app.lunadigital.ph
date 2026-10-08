// Granular permission keys + role templates.
//
// Luna NEVER branches on a role name. Every access decision — Firestore
// rules, Netlify Functions, navigation — checks a permission key. A "role"
// is only a named template that expands into a set of permission keys, so
// new roles (Warehouse Staff, Sales Staff, Finance, ...) are added here as
// data without touching any code that enforces access.
//
// Every permission belongs to exactly one module (shared/modules.js). A
// permission is only usable while the business is entitled to that module:
// holding reports.view does nothing if Reports is off for the business.
//
// The resolved permission map is computed server-side and stored on the
// member document (businesses/{bid}/members/{uid}.permissions); the client
// copy of this file is only used to render UI.

export const PERMISSIONS = Object.freeze({
  "dashboard.view": { module: "dashboard", group: "Dashboard", label: "View dashboard" },
  // Sales, gross profit, expenses and estimated operating profit on the
  // dashboard. Separate from dashboard.view so staff who enter orders don't
  // see profitability by default.
  "dashboard.financials": { module: "dashboard", group: "Dashboard", label: "View sales and profitability on the dashboard" },

  "orders.view": { module: "orders", group: "Orders", label: "View orders" },
  "orders.create": { module: "orders", group: "Orders", label: "Create orders" },
  "orders.update": { module: "orders", group: "Orders", label: "Edit pending orders" },
  "orders.fulfill": { module: "orders", group: "Orders", label: "Fulfill orders" },
  "orders.cancel": { module: "orders", group: "Orders", label: "Cancel or delete open orders" },
  // Editing a FULFILLED order changes stock, sales and COGS after the fact.
  "orders.correct": { module: "orders", group: "Orders", label: "Correct fulfilled orders" },
  // Discounts change profitability; staff who enter orders don't get them by default.
  "orders.discount": { module: "orders", group: "Orders", label: "Give order discounts" },

  "payments.view": { module: "payments", group: "Payments", label: "View payments" },
  "payments.record": { module: "payments", group: "Payments", label: "Record payments" },
  // Verifying, correcting and removing payments: sensitive, owner/manager by default.
  "payments.verify": { module: "payments", group: "Payments", label: "Verify, correct and remove payments" },

  "inventory.view": { module: "inventory", group: "Inventory", label: "View inventory" },
  "inventory.receive": { module: "inventory", group: "Inventory", label: "Receive stock" },
  "inventory.adjust": { module: "inventory", group: "Inventory", label: "Adjust stock and record opening balances" },
  // Average cost, inventory value and cost history. Separate from
  // inventory.view so warehouse staff can see quantities without costs
  // (same principle as dashboard.financials).
  "inventory.costs": { module: "inventory", group: "Inventory", label: "View product costs and inventory value" },
  "products.manage": { module: "inventory", group: "Inventory", label: "Manage products" },

  "customers.view": { module: "customers", group: "Customers", label: "View customers" },
  "customers.manage": { module: "customers", group: "Customers", label: "Manage customers" },

  "reports.view": { module: "reports", group: "Reports", label: "View basic reports" },
  "reports.advanced": { module: "reports", group: "Reports", label: "View sensitive / advanced reports" },
  "reports.export": { module: "reports", group: "Reports", label: "Export reports" },

  "expenses.view": { module: "expenses", group: "Expenses", label: "View expenses" },
  "expenses.create": { module: "expenses", group: "Expenses", label: "Record expenses" },
  "expenses.update": { module: "expenses", group: "Expenses", label: "Edit expenses" },
  "expenses.delete": { module: "expenses", group: "Expenses", label: "Delete expenses" },

  "imports.run": { module: "imports", group: "Imports", label: "Run spreadsheet imports" },

  "users.view": { module: "users", group: "Users", label: "View team members" },
  "users.manage": { module: "users", group: "Users", label: "Invite and manage team members" },

  "settings.view": { module: "settings", group: "Settings", label: "View business settings" },
  "settings.manage": { module: "settings", group: "Settings", label: "Change business settings" },
  "integrations.manage": { module: "settings", group: "Settings", label: "Manage integrations" },

  "billing.view": { module: "settings", group: "Subscription", label: "View subscription and billing" },
});

export const PERMISSION_KEYS = Object.freeze(Object.keys(PERMISSIONS));

const ALL = PERMISSION_KEYS;

export const ROLE_TEMPLATES = Object.freeze({
  owner: {
    label: "Owner",
    description: "Full access to the business, including subscription and team.",
    permissions: ALL,
  },
  manager: {
    label: "Manager / Admin",
    description: "Runs daily operations and reports. No subscription, team or business configuration.",
    permissions: ALL.filter((key) => !["billing.view", "users.manage", "settings.manage", "integrations.manage"].includes(key)),
  },
  staff: {
    label: "Staff",
    description: "Encodes and updates orders and payments. No reports, team or settings.",
    permissions: [
      "dashboard.view",
      "orders.view",
      "orders.create",
      "orders.update",
      "orders.fulfill",
      "payments.view",
      "payments.record",
      "inventory.view",
      "customers.view",
      "customers.manage",
    ],
  },
});

export function isPermissionKey(key) {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, key);
}

// Expands a role template plus optional per-member overrides into a
// { [permissionKey]: true } map. Overrides are { grant: [...], revoke: [...] }.
// Unknown template ids or permission keys throw — a typo must never silently
// grant or drop access.
export function resolvePermissions(templateId, overrides = {}) {
  const template = ROLE_TEMPLATES[templateId];
  if (!template) throw new Error(`Unknown role template: ${templateId}`);

  const grant = overrides.grant || [];
  const revoke = overrides.revoke || [];
  for (const key of [...grant, ...revoke]) {
    if (!isPermissionKey(key)) throw new Error(`Unknown permission: ${key}`);
  }

  const result = {};
  for (const key of template.permissions) result[key] = true;
  for (const key of grant) result[key] = true;
  for (const key of revoke) delete result[key];
  return result;
}

// The module a permission belongs to, or null for an unknown key.
export function moduleForPermission(key) {
  return isPermissionKey(key) ? PERMISSIONS[key].module : null;
}

export function hasPermission(permissionMap, key) {
  return Boolean(permissionMap) && permissionMap[key] === true;
}
