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
//   modules        the OPERATIONAL modules the template allows (core
//                  included): registered AND built (available). This is a
//                  ceiling: effective modules = built ∩ template allows
//                  ∩ (plan default, or an operator add-on/disable
//                  override) — see computeEntitlements.
//   navigation     module ids in display order
//   mobileTabs     (Phase 18.5) up to three navigation ids for the phone tab
//                  bar, after Dashboard (display only); up to four when the
//                  template has no Dashboard in its navigation
//   navHidden      (Owner-pilot UX) allowed modules kept OUT of the
//                  navigation (still entitled, can come back): Household
//                  hides the Dashboard
//   home           (Owner-pilot UX) the module "/" opens when the Dashboard
//                  is hidden (Household: payroll)
//   menuHidden     (Owner-pilot Bridal UX) navigation modules that keep
//                  their route but get no menu entry: reached from another
//                  page (Bridal: Wedding Expenses and Supplier Payments open
//                  from Money)
//   dashboard      widget ids (shared/dashboard.js) in display order, and
//                  the empty state shown when none apply yet
//   labels         plain-text display names by module id; ids, permission
//                  keys and security rules never depend on these
//   settings       default workspace settings (plain JSON values)
//   plannedModules roadmap metadata ONLY (Luna-wide requirements such as
//                  filtered Excel downloads apply to each when it's built;
//                  see docs/ARCHITECTURE.md): no route, no permission, no
//                  entitlement, never shown as navigation. An entry may
//                  name a registered-but-unbuilt module (e.g. customers)
//                  or a future domain capability (e.g. wedding-tasks).
//
// Activating a module is always explicit: mark it available in
// shared/modules.js, move it from plannedModules to modules in each
// template that should get it, bump those templates' versions, then
// recompute snapshots through the staged rollout. Shipping module code
// alone activates nothing: a module is operational only in the templates
// whose `modules` list it (a built module can stay planned elsewhere),
// old snapshots hold false for it, and the registry tests fail if an
// unbuilt module is listed as operational.
//
// No executable code, HTML, CSS, collection names or routes come from a
// template or a tenant. firestore.rules / storage.rules keep a copy of
// each template's id, version and allowed modules;
// tests/shared/rules-registry.test.js fails if they drift.
//
// Bump `version` whenever a template's modules change, listing the old
// version in `upgradingFrom` while snapshots are recomputed (then empty
// it). Every snapshot
// records the version it was computed with; a mismatch is stale and fails
// closed until recompute-entitlements runs (see docs/ARCHITECTURE.md for
// the rollout order).
//
// This file deliberately imports nothing (shared/modules.js imports it).

// Entitlement snapshot version (shared/entitlements.js re-exports it).
// 2 carries the workspace. The Phase 4-8 shape (1, no workspace) was
// accepted only during the Phase 8.5 migration and is now rejected: there
// is no "missing workspace = distributor".
export const ENTITLEMENTS_SCHEMA_VERSION = 2;

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
    // v2 (Phase 9): Customers became operational. v3 (Phase 10): Expenses.
    // v4 (Phase 11): Reports. v5 (Phase 12): Imports. (Older snapshots were
    // accepted via upgradingFrom only until every business was recomputed.)
    version: 5,
    name: "Distributor Operations",
    description: "Orders, payments, products and inventory for distributors and wholesalers.",
    status: "live",
    modules: [...CORE, "orders", "payments", "inventory", "customers", "expenses", "reports", "imports"],
    // Phase 18.5: navigation follows the daily story (Monitor → Work →
    // Analyze → Manage); phones show Dashboard + mobileTabs + More.
    // Owner pilot (2026-10-19, Business simplification): Customers is kept
    // (entitled; orders still take optional customer details and may link a
    // saved customer) but has no page or menu entry; Operating Expenses + COGS
    // are one "Costs" page. Phone: Dashboard · Orders · Inventory · Payments
    // + More (Costs, Reports, Users, Download Excel, Settings).
    navigation: ["dashboard", "orders", "payments", "inventory", "expenses", "reports", "imports", "users", "settings"],
    navHidden: ["customers"],
    mobileTabs: ["orders", "inventory", "payments"],
    dashboard: {
      // Selected period first, then current operations (Phase 12.5). The
      // Dashboard workbook (Download Excel) lists all of these. Owner pilot:
      // the SCREEN is the checkout and shows only Total sales, Total orders
      // and Gross profit (src/modules/dashboard SCREEN_WIDGETS); COGS and
      // operating profit detail stay in Reports.
      widgets: ["netSales", "ordersToday", "grossProfit", "fulfilledOrders", "receivablesOutstanding", "unpaidOrders", "pendingFulfillment", "lowStock", "paymentsToVerify", "ordersPending", "ordersPreparing", "ordersReady", "inventorySummary", "recentOrders", "lowStockItems"],
      empty: { title: "Nothing to show yet", body: "Your dashboard fills in as your business uses Luna." },
    },
    labels: { modules: { expenses: "Costs" } },
    settings: { orderPrefix: "ORD" },
    plannedModules: [
      { id: "suppliers", name: "Suppliers" },
      { id: "production", name: "Production" },
      { id: "returns", name: "Returns" },
    ],
  },
  {
    id: "household-payroll",
    // v2 (Phase 14): Household Staff, Attendance, Payroll (deductions,
    // salary release, receipt confirmation, history) and Advances.
    // v3 (Luna Household): + household money on the shared primitives:
    // Expenses (the Expenses Core, Household profile), Budget & Categories
    // (a MONTHLY budget) and the Payment Schedule as "Bills" (recurring).
    // Payroll stays authoritative: paid salaries are summarized, never
    // re-entered as expenses. v2 snapshots are accepted (upgradingFrom)
    // until every Household business is recomputed; the same businessId
    // and data throughout.
    // v4 (2026-10-17): + the Grocery List (under More; household staff can
    // see it and tick items). v2 / v3 snapshots stay accepted.
    version: 4,
    upgradingFrom: [2, 3],
    name: "Luna Household",
    description: "Your household, organized: household staff, payroll, bills and household spending in one place.",
    status: "live",
    modules: [...CORE, "household", "attendance", "payroll", "advances", "expenses", "budget", "schedule", "grocery"],
    // Owner-pilot UX: no Dashboard in Household. Payroll is the home page;
    // what needs attention lives in the bell. Phone: Payroll, Attendance,
    // Expenses + More (Advances, Household Staff, Bills, Grocery List, Export
    // & Backup, Users, Subscription, Settings). No budget in Household (expense
    // monitoring, not budgeting): the "budget" module is just Categories,
    // opened from Expenses → ⋯ → Manage categories.
    navigation: ["payroll", "attendance", "expenses", "advances", "household", "schedule", "grocery", "budget", "users", "settings"],
    mobileTabs: ["payroll", "attendance", "expenses"],
    navHidden: ["dashboard"],
    menuHidden: ["budget"],
    home: "payroll",
    dashboard: {
      widgets: ["activeStaff", "attendanceToday", "payrollsToRelease", "awaitingReceipt", "advancesNotPaid", "advancesToDeduct"],
      empty: { title: "Your payroll workspace is ready", body: "Add your household staff to start marking attendance." },
    },
    labels: { modules: { dashboard: "Payroll Dashboard", expenses: "Expenses", schedule: "Bills", budget: "Categories", household: "Household Staff" } },
    settings: {},
    plannedModules: [{ id: "payroll-reports", name: "Payroll Reports" }],
  },
  {
    id: "baby-expense",
    // v2 (Phase 15): Baby Expenses (the Expenses Core with the Baby
    // profile), Budget & Categories, Payment Schedule, Providers / Vendors.
    // (v1 snapshots were accepted via upgradingFrom only until every
    // business was recomputed.)
    version: 2,
    name: "Baby Expense Tracker",
    description: "Budget and track a baby's expenses, providers and upcoming payments.",
    status: "live",
    modules: [...CORE, "expenses", "budget", "schedule", "providers"],
    navigation: ["dashboard", "budget", "expenses", "schedule", "providers", "users", "settings"],
    mobileTabs: ["expenses", "budget", "schedule"],
    dashboard: {
      // Selected period (spending), then the current budget (as of now).
      // Phase 18.6: three money cards, who paid, and what's coming up.
      widgets: ["budgetSpent", "budgetUpcoming", "babySpentThisMonth", "budgetPayers", "upcomingPayments"],
      empty: { title: "Ready to track baby expenses", body: "Add an expense to start. A budget is optional." },
      sectionLabels: { period: "Spending in the selected period", current: "Current budget" },
    },
    labels: { modules: { dashboard: "Baby Dashboard", budget: "Budget & Categories", expenses: "Baby Expenses", schedule: "Payment Schedule", providers: "Providers / Vendors" } },
    settings: {},
    plannedModules: [
      { id: "milestones", name: "Milestones" },
      { id: "baby-reports", name: "Reports" },
    ],
  },
  {
    id: "bridal-expense",
    // v2 (Phase 16): Wedding Budget (the generic budget primitive), Wedding
    // Expenses (the Expenses Core with the Bridal profile), Wedding
    // Suppliers, Supplier Payments, Wedding Tasks, Guests & RSVP. (v1
    // snapshots were accepted via upgradingFrom only until every business
    // was recomputed.)
    version: 2,
    name: "Bridal / Wedding Management Tracker",
    description: "A compact wedding command center: budget, suppliers, payments, tasks and guests.",
    status: "live",
    modules: [...CORE, "expenses", "budget", "vendors", "vendorpayments", "tasks", "guests"],
    // Owner-pilot Bridal UX: no Dashboard. Money (budget, suppliers, other
    // expenses, payments: the Wedding Suppliers module) is the home page,
    // then Tasks and Guests. Budget planning lives in Money (+ Add → Budget
    // item, Sample Budget), so the Budget page left the menu like Wedding
    // Expenses and Supplier Payments: their pages and data stay (opened from
    // Money / old links); More holds Wedding Setup, Music & Program, Export
    // & Backup, Users, Subscription, Settings. The dashboard
    // module itself stays (core) so it can come back.
    navigation: ["vendors", "tasks", "guests", "budget", "expenses", "vendorpayments", "users", "settings"],
    mobileTabs: ["vendors", "tasks", "guests"],
    navHidden: ["dashboard"],
    menuHidden: ["budget", "expenses", "vendorpayments"],
    home: "vendors",
    dashboard: {
      // Selected period (spending, payments made), then the current state (as of now).
      widgets: ["weddingSpent", "weddingSupplierPaid", "weddingExpenseCount", "weddingBudgetTotal", "weddingSpentNow", "weddingRemaining", "weddingSupplierBalance", "weddingUpcoming", "weddingOpenTasks", "weddingOverdueTasks", "weddingConfirmedGuests", "weddingAwaitingRsvp", "upcomingSupplierPayments", "tasksDueSoon", "recentWeddingExpenses", "rsvpSummary", "supplierSummary"],
      empty: { title: "Your wedding workspace is ready", body: "Set your budget, add suppliers, tasks and guests to get started." },
      sectionLabels: { period: "Spending in the selected period", current: "Wedding plan" },
    },
    labels: { modules: { dashboard: "Wedding Dashboard", budget: "Budget", expenses: "Wedding Expenses", vendors: "Money", vendorpayments: "Supplier Payments", tasks: "Tasks", guests: "Guests" } },
    settings: {},
    plannedModules: [{ id: "wedding-reports", name: "Reports" }],
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

// The workspace a snapshot was computed for, or null (missing, malformed
// or unknown). Works on the full stored snapshot and on the session copy
// the browser receives.
export function snapshotWorkspaceTemplateId(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  return getWorkspaceTemplate(snapshot.workspaceTemplateId) ? snapshot.workspaceTemplateId : null;
}

// Versions a stored snapshot may carry for this template right now: the
// current one, plus any listed in upgradingFrom during a rollout window.
export function acceptedTemplateVersions(id) {
  const t = getWorkspaceTemplate(id);
  return t ? [...(t.upgradingFrom || []), t.version] : [];
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

// The dashboard's heading for a section ("period" / "current") in this
// workspace, e.g. Baby's "Current budget"; `fallback` otherwise.
export function workspaceSectionLabel(templateId, sectionId, fallback) {
  const t = getWorkspaceTemplate(templateId);
  const labels = t && t.dashboard.sectionLabels;
  return (labels && Object.hasOwn(labels, sectionId) && labels[sectionId]) || fallback;
}

// Labels are short plain text: letters, digits, spaces and a few
// punctuation marks. No markup, no control characters.
export function isSafeLabel(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 40 && value.trim() === value && /^[\p{L}\p{N} &'(),./-]+$/u.test(value);
}

// Structural check of a template definition, used by the registry tests
// against the module and dashboard registries passed in (kept as
// parameters so this file stays import-free).
export function validateWorkspaceTemplate(t, { moduleIds, coreModuleIds, availableModuleIds, widgets }) {
  const problems = [];
  const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  if (!isObj(t)) return ["template must be an object"];
  const allowedKeys = ["id", "version", "upgradingFrom", "name", "description", "status", "modules", "navigation", "mobileTabs", "navHidden", "menuHidden", "home", "dashboard", "labels", "settings", "plannedModules"];
  for (const k of Object.keys(t)) if (!allowedKeys.includes(k)) problems.push(`unknown key ${k}`);
  if (typeof t.id !== "string" || !WORKSPACE_TEMPLATE_ID_PATTERN.test(t.id)) problems.push("invalid id");
  if (!Number.isSafeInteger(t.version) || t.version < 1) problems.push("version must be a positive integer");
  if (t.upgradingFrom !== undefined && (!Array.isArray(t.upgradingFrom) || t.upgradingFrom.some((v) => !Number.isSafeInteger(v) || v < 1 || v >= t.version))) problems.push("upgradingFrom must list earlier versions");
  for (const k of ["name", "description"]) if (typeof t[k] !== "string" || !t[k].trim() || /[<>]/.test(t[k])) problems.push(`${k} must be plain text`);
  if (!["live", "planned"].includes(t.status)) problems.push("status must be live or planned");

  const mods = Array.isArray(t.modules) ? t.modules : [];
  if (!Array.isArray(t.modules) || new Set(mods).size !== mods.length) problems.push("modules must be a list without duplicates");
  for (const m of mods) {
    if (!moduleIds.includes(m)) problems.push(`unknown module ${m}`);
    else if (!availableModuleIds.includes(m)) problems.push(`module ${m} isn't built: list it in plannedModules until it is`);
  }
  for (const m of coreModuleIds) if (!mods.includes(m)) problems.push(`core module ${m} missing`);

  const nav = Array.isArray(t.navigation) ? t.navigation : [];
  if (!Array.isArray(t.navigation) || new Set(nav).size !== nav.length) problems.push("navigation must be a list without duplicates");
  for (const m of nav) if (!mods.includes(m)) problems.push(`navigation ${m} isn't an allowed module`);
  const hidden = t.navHidden === undefined ? [] : Array.isArray(t.navHidden) ? t.navHidden : null;
  if (!hidden || new Set(hidden).size !== hidden.length) problems.push("navHidden must be a list without duplicates");
  for (const m of hidden || []) if (!mods.includes(m) || nav.includes(m)) problems.push(`navHidden ${m} must be an allowed module that isn't in the navigation`);
  for (const m of mods) if (!nav.includes(m) && !(hidden || []).includes(m)) problems.push(`allowed module ${m} has no navigation position`);
  if (t.home !== undefined && (!nav.includes(t.home) || t.home === "dashboard")) problems.push("home must be a navigation module");
  const menuHidden = t.menuHidden === undefined ? [] : Array.isArray(t.menuHidden) ? t.menuHidden : null;
  if (!menuHidden || new Set(menuHidden).size !== menuHidden.length) problems.push("menuHidden must be a list without duplicates");
  for (const m of menuHidden || []) if (!nav.includes(m) || m === t.home || (t.mobileTabs || []).includes(m)) problems.push(`menuHidden ${m} must be a navigation module that isn't home or a phone tab`);
  if (t.home === undefined && !nav.includes("dashboard")) problems.push("a template without the Dashboard in its navigation needs a home module");
  // Phase 18.5: up to three phone tabs (after Dashboard), from the navigation;
  // four when there's no Dashboard tab.
  if (t.mobileTabs !== undefined) {
    const tabs = Array.isArray(t.mobileTabs) ? t.mobileTabs : null;
    const room = nav.includes("dashboard") ? 3 : 4;
    if (!tabs || tabs.length > room || new Set(tabs).size !== tabs.length) problems.push(`mobileTabs must be up to ${room === 3 ? "three" : "four"} distinct module ids`);
    else for (const m of tabs) if (!nav.includes(m) || m === "dashboard") problems.push(`mobileTabs ${m} isn't a navigation module`);
  }

  if (!isObj(t.dashboard) || !Array.isArray(t.dashboard.widgets) || !isObj(t.dashboard.empty)) problems.push("dashboard must have widgets and empty");
  else {
    const ids = t.dashboard.widgets;
    if (new Set(ids).size !== ids.length) problems.push("duplicate dashboard widget");
    for (const id of ids) {
      const w = widgets.find((x) => x.id === id);
      if (!w) problems.push(`unknown widget ${id}`);
      else for (const m of w.modules) if (!mods.includes(m) && !(t.plannedModules || []).some((p) => p && p.id === m)) problems.push(`widget ${id} needs module ${m} the template neither allows nor plans`);
    }
    for (const k of ["title", "body"]) if (typeof t.dashboard.empty[k] !== "string" || /[<>]/.test(t.dashboard.empty[k])) problems.push(`dashboard.empty.${k} must be plain text`);
    for (const k of Object.keys(t.dashboard)) if (!["widgets", "empty", "sectionLabels"].includes(k)) problems.push(`unknown dashboard key ${k}`);
    if (t.dashboard.sectionLabels !== undefined) {
      if (!isObj(t.dashboard.sectionLabels)) problems.push("dashboard.sectionLabels must be an object");
      else for (const [k, v] of Object.entries(t.dashboard.sectionLabels)) if (!["period", "current"].includes(k) || typeof v !== "string" || !v.trim() || v.length > 60 || /[<>]/.test(v)) problems.push(`invalid dashboard section label ${k}`);
    }
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
      // Roadmap only: a planned id is a registered module this template
      // hasn't activated (built or not: Expenses is built for Distributor
      // but still planned for Baby and Bridal), or a future capability id
      // that isn't registered at all. Never both planned and operational.
      else if (mods.includes(p.id)) problems.push(`planned module ${p.id} is also listed as operational`);
    }
  }
  return problems;
}
