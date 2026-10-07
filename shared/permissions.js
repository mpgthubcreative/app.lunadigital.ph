// Granular permission keys + role templates.
//
// Luna NEVER branches on a role name. Every access decision — Firestore
// rules, Netlify Functions, navigation — checks a permission key. A "role"
// is only a named template that expands into a set of permission keys, so
// new roles (Warehouse Staff, Sales Staff, Finance, ...) are added here as
// data without touching any code that enforces access.
//
// The resolved permission map is computed server-side and stored on the
// member document (businesses/{bid}/members/{uid}.permissions); the client
// copy of this file is only used to render UI.

export const PERMISSIONS = Object.freeze({
  "dashboard.view": { group: "Dashboard", label: "View dashboard" },

  "orders.view": { group: "Orders", label: "View orders" },
  "orders.create": { group: "Orders", label: "Create orders" },
  "orders.update": { group: "Orders", label: "Update order status" },
  "orders.cancel": { group: "Orders", label: "Cancel orders" },

  "payments.view": { group: "Payments", label: "View payments" },
  "payments.record": { group: "Payments", label: "Record payments" },
  "payments.verify": { group: "Payments", label: "Verify payments" },

  "inventory.view": { group: "Inventory", label: "View inventory" },
  "inventory.adjust": { group: "Inventory", label: "Adjust stock" },
  "products.manage": { group: "Inventory", label: "Manage products" },

  "customers.view": { group: "Customers", label: "View customers" },
  "customers.manage": { group: "Customers", label: "Manage customers" },

  "reports.view": { group: "Reports", label: "View basic reports" },
  "reports.advanced": { group: "Reports", label: "View sensitive / advanced reports" },
  "reports.export": { group: "Reports", label: "Export reports" },

  "imports.run": { group: "Imports", label: "Run spreadsheet imports" },

  "users.view": { group: "Users", label: "View team members" },
  "users.manage": { group: "Users", label: "Invite and manage team members" },

  "settings.view": { group: "Settings", label: "View business settings" },
  "settings.manage": { group: "Settings", label: "Change business settings" },
  "integrations.manage": { group: "Settings", label: "Manage integrations" },

  "billing.view": { group: "Subscription", label: "View subscription and billing" },
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

export function hasPermission(permissionMap, key) {
  return Boolean(permissionMap) && permissionMap[key] === true;
}
