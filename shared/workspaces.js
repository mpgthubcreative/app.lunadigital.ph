// Workspace template registry (Phase 8.5).
//
//   Luna Core -> Workspace Template -> Enabled Modules -> Tenant Configuration
//
// A template says what KIND of workspace a business runs (distributor,
// household payroll, ...). It is independent of the commercial plan
// (shared/plans.seed.js): a business has one workspaceTemplateId and one
// subscription.planId, never a combined "distributor-growth".
//
// A template is data, never code:
//   modules        every module the template ALLOWS (core included). This
//                  is a ceiling: effective modules = template allows
//                  ∩ (plan default, or an operator override) — see
//                  computeEntitlements in shared/entitlements.js.
//   navigation     module ids in display order
//   dashboard      widget ids (shared/dashboard.js) in display order, and
//                  the empty state shown when none apply yet
//   labels         plain-text display names by module id; ids, permission
//                  keys and security rules never depend on these
//   settings       default workspace settings (plain JSON values)
//   plannedModules roadmap metadata ONLY: no route, no permission, no
//                  entitlement, never shown as navigation
//
// No executable code, HTML, CSS, collection names or routes come from a
// template or a tenant. firestore.rules / storage.rules keep a copy of
// each template's id, version and allowed modules;
// tests/shared/rules-registry.test.js fails if they drift.
//
// Bump `version` whenever a template's modules change. Every snapshot
// records the version it was computed with; a mismatch is stale and fails
// closed until recompute-entitlements runs (see docs/ARCHITECTURE.md for
// the rollout order).
//
// This file deliberately imports nothing (shared/modules.js imports it).

// Entitlement snapshot versions (shared/entitlements.js re-exports them).
// 2 carries the workspace; 1 is the Phase 4-8 shape without one.
export const ENTITLEMENTS_SCHEMA_VERSION = 2;
export const LEGACY_ENTITLEMENTS_SCHEMA_VERSION = 1;

// Phase 8.5 migration window: schemaVersion-1 snapshots (no workspace) are
// still accepted and read as distributor. Becomes false, with the legacy
// branches removed, once every business is migrated (enforcement step).
export const LEGACY_SNAPSHOTS_ACCEPTED = true;

export const WORKSPACE_TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const CORE = ["dashboard", "users", "settings"];

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const TEMPLATES = [
  {
    id: "distributor",
    version: 1,
    name: "Distributor Operations",
    description: "Orders, payments, products and inventory for distributors and wholesalers.",
    status: "live",
    modules: [...CORE, "orders", "payments", "inventory", "customers", "reports", "expenses", "imports", "suppliers", "production", "returns"],
    navigation: ["dashboard", "orders", "payments", "inventory", "customers", "reports", "expenses", "imports", "users", "settings", "suppliers", "production", "returns"],
    dashboard: {
      widgets: ["netSales", "grossProfit", "operatingExpenses", "estimatedOperatingProfit", "paymentsReceived", "receivablesOutstanding", "ordersToday", "unpaidOrders", "pendingFulfillment", "lowStock", "recentOrders", "lowStockItems", "recentActivity"],
      empty: { title: "Nothing to show yet", body: "Your dashboard fills in as your business uses Luna." },
    },
    labels: { modules: { expenses: "Operating Expenses" } },
    settings: { orderPrefix: "ORD" },
    plannedModules: [{ id: "notifications", name: "Notifications" }],
  },
  {
    id: "household-payroll",
    version: 1,
    name: "Household / Kasambahay Payroll",
    description: "Pay household staff, record what was released and get each payment confirmed by the person who received it.",
    status: "planned",
    modules: [...CORE],
    navigation: [...CORE],
    dashboard: { widgets: [], empty: { title: "Your payroll workspace is being prepared", body: "Payroll, salary releases and receipt confirmations will appear here." } },
    labels: { modules: { dashboard: "Payroll Dashboard" } },
    settings: {},
    plannedModules: [
      { id: "household-staff", name: "Household Staff" },
      { id: "payroll", name: "Payroll" },
      { id: "salary-payments", name: "Salary Payments" },
      { id: "receipt-confirmation", name: "Employee Receipt Confirmation" },
      { id: "advances", name: "Advances" },
      { id: "deductions", name: "Deductions" },
      { id: "payroll-history", name: "Payroll History" },
      { id: "payroll-reports", name: "Reports" },
    ],
  },
  {
    id: "baby-expense",
    version: 1,
    name: "Baby Expense Tracker",
    description: "Budget and track a baby's expenses, providers and upcoming payments.",
    status: "planned",
    modules: [...CORE, "expenses"],
    navigation: [...CORE.slice(0, 1), "expenses", ...CORE.slice(1)],
    dashboard: { widgets: [], empty: { title: "Your baby budget workspace is being prepared", body: "Budget, spending and upcoming payments will appear here." } },
    labels: { modules: { dashboard: "Baby Dashboard", expenses: "Baby Expenses" } },
    settings: {},
    plannedModules: [
      { id: "baby-budget", name: "Budget" },
      { id: "expense-categories", name: "Categories" },
      { id: "providers", name: "Vendors / Providers" },
      { id: "baby-payments", name: "Payments" },
      { id: "due-dates", name: "Due Dates" },
      { id: "milestones", name: "Milestones" },
      { id: "baby-reports", name: "Reports" },
    ],
  },
  {
    id: "bridal-expense",
    version: 1,
    name: "Bridal / Wedding Management Tracker",
    description: "A compact wedding command center: budget, suppliers, payments, tasks and guests.",
    status: "planned",
    modules: [...CORE, "expenses"],
    navigation: [...CORE.slice(0, 1), "expenses", ...CORE.slice(1)],
    dashboard: { widgets: [], empty: { title: "Your wedding workspace is being prepared", body: "Budget, supplier balances, tasks and RSVPs will appear here." } },
    labels: { modules: { dashboard: "Wedding Dashboard", expenses: "Wedding Expenses" } },
    settings: {},
    plannedModules: [
      { id: "wedding-budget", name: "Budget" },
      { id: "wedding-suppliers", name: "Wedding Suppliers" },
      { id: "supplier-payments", name: "Supplier Payments" },
      { id: "supplier-balances", name: "Supplier Balances" },
      { id: "payment-due-dates", name: "Payment Due Dates" },
      { id: "wedding-tasks", name: "Wedding Tasks / To-Do List" },
      { id: "guests", name: "Guests / Invitees" },
      { id: "rsvp", name: "RSVP Tracking" },
      { id: "wedding-reports", name: "Reports" },
    ],
  },
];

export const WORKSPACE_TEMPLATES = deepFreeze(Object.fromEntries(TEMPLATES.map((t) => [t.id, t])));
export const WORKSPACE_TEMPLATE_IDS = Object.freeze(TEMPLATES.map((t) => t.id));

// Exact registered id only; anything else (missing, malformed, unknown,
// prototype keys) is null.
export function getWorkspaceTemplate(id) {
  if (typeof id !== "string" || !WORKSPACE_TEMPLATE_ID_PATTERN.test(id) || !Object.hasOwn(WORKSPACE_TEMPLATES, id)) return null;
  return WORKSPACE_TEMPLATES[id];
}

// The workspace a snapshot was computed for, or null. Works on the full
// stored snapshot and on the session copy the browser receives. A legacy
// (schemaVersion 1) snapshot predates workspaces: during the migration
// window only, it is read as the distributor workspace it was built for.
export function snapshotWorkspaceTemplateId(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  if (snapshot.workspaceTemplateId !== undefined) return getWorkspaceTemplate(snapshot.workspaceTemplateId) ? snapshot.workspaceTemplateId : null;
  if (LEGACY_SNAPSHOTS_ACCEPTED && snapshot.schemaVersion === LEGACY_ENTITLEMENTS_SCHEMA_VERSION) return "distributor";
  return null;
}

export function isValidWorkspaceTemplateId(id) {
  return getWorkspaceTemplate(id) !== null;
}

export function workspaceAllowsModule(templateId, moduleId) {
  const t = getWorkspaceTemplate(templateId);
  return Boolean(t) && t.modules.includes(moduleId);
}

// Display label for a module in a workspace (plain text; rendered through
// the escaping html`` helper like every other string).
export function workspaceModuleLabel(templateId, moduleId, fallback) {
  const t = getWorkspaceTemplate(templateId);
  const label = t && Object.hasOwn(t.labels.modules, moduleId) ? t.labels.modules[moduleId] : null;
  return label || fallback;
}

// Labels are short plain text: letters, digits, spaces and a few
// punctuation marks. No markup, no control characters.
export function isSafeLabel(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 40 && value.trim() === value && /^[\p{L}\p{N} &'(),./-]+$/u.test(value);
}

// Structural check of a template definition, used by the registry tests
// against the module and dashboard registries passed in (kept as
// parameters so this file stays import-free).
export function validateWorkspaceTemplate(t, { moduleIds, coreModuleIds, widgets }) {
  const problems = [];
  const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  if (!isObj(t)) return ["template must be an object"];
  const allowedKeys = ["id", "version", "name", "description", "status", "modules", "navigation", "dashboard", "labels", "settings", "plannedModules"];
  for (const k of Object.keys(t)) if (!allowedKeys.includes(k)) problems.push(`unknown key ${k}`);
  if (typeof t.id !== "string" || !WORKSPACE_TEMPLATE_ID_PATTERN.test(t.id)) problems.push("invalid id");
  if (!Number.isSafeInteger(t.version) || t.version < 1) problems.push("version must be a positive integer");
  for (const k of ["name", "description"]) if (typeof t[k] !== "string" || !t[k].trim() || /[<>]/.test(t[k])) problems.push(`${k} must be plain text`);
  if (!["live", "planned"].includes(t.status)) problems.push("status must be live or planned");

  const mods = Array.isArray(t.modules) ? t.modules : [];
  if (!Array.isArray(t.modules) || new Set(mods).size !== mods.length) problems.push("modules must be a list without duplicates");
  for (const m of mods) if (!moduleIds.includes(m)) problems.push(`unknown module ${m}`);
  for (const m of coreModuleIds) if (!mods.includes(m)) problems.push(`core module ${m} missing`);

  const nav = Array.isArray(t.navigation) ? t.navigation : [];
  if (!Array.isArray(t.navigation) || new Set(nav).size !== nav.length) problems.push("navigation must be a list without duplicates");
  for (const m of nav) if (!mods.includes(m)) problems.push(`navigation ${m} isn't an allowed module`);
  for (const m of mods) if (!nav.includes(m)) problems.push(`allowed module ${m} has no navigation position`);

  if (!isObj(t.dashboard) || !Array.isArray(t.dashboard.widgets) || !isObj(t.dashboard.empty)) problems.push("dashboard must have widgets and empty");
  else {
    const ids = t.dashboard.widgets;
    if (new Set(ids).size !== ids.length) problems.push("duplicate dashboard widget");
    for (const id of ids) {
      const w = widgets.find((x) => x.id === id);
      if (!w) problems.push(`unknown widget ${id}`);
      else for (const m of w.modules) if (!mods.includes(m)) problems.push(`widget ${id} needs module ${m} the template doesn't allow`);
    }
    for (const k of ["title", "body"]) if (typeof t.dashboard.empty[k] !== "string" || /[<>]/.test(t.dashboard.empty[k])) problems.push(`dashboard.empty.${k} must be plain text`);
  }

  if (!isObj(t.labels) || !isObj(t.labels.modules) || Object.keys(t.labels).some((k) => k !== "modules")) problems.push("labels must be { modules }");
  else for (const [m, label] of Object.entries(t.labels.modules)) {
    if (!mods.includes(m)) problems.push(`label for module ${m} the template doesn't allow`);
    if (!isSafeLabel(label)) problems.push(`label for ${m} isn't safe plain text`);
  }

  if (!isObj(t.settings)) problems.push("settings must be an object");
  else for (const [k, v] of Object.entries(t.settings)) if (!["string", "number", "boolean"].includes(typeof v)) problems.push(`setting ${k} must be a plain value`);

  if (!Array.isArray(t.plannedModules)) problems.push("plannedModules must be a list");
  else {
    const ids = t.plannedModules.map((p) => p && p.id);
    if (new Set(ids).size !== ids.length) problems.push("duplicate planned module");
    for (const p of t.plannedModules) {
      if (!isObj(p) || typeof p.id !== "string" || !WORKSPACE_TEMPLATE_ID_PATTERN.test(p.id) || !isSafeLabel(p.name) || Object.keys(p).some((k) => !["id", "name"].includes(k))) problems.push(`invalid planned module ${JSON.stringify(p)}`);
      // Roadmap only: a planned id must never collide with a real module.
      else if (moduleIds.includes(p.id)) problems.push(`planned module ${p.id} is a registered module`);
    }
  }
  return problems;
}
