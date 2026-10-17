// INITIAL plan configuration — not validated final pricing.
//
// This file is the seed for the Firestore `plans/{planId}` collection,
// which becomes the editable source of truth (Super Admin, Phase 14). Code
// must never read limits or prices from anywhere else: the server computes
// each business's effective entitlements from the stored plan + that
// business's overrides (see entitlements.js), and the UI only displays
// what the server resolved.
//
// Money is stored as integer centavos (PHP) to avoid floating-point error;
// use formatMoney() for display. `*IsMinimum` marks "starts at" pricing
// (e.g. Pro "₱19,990+").

export const CURRENCY = "PHP";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

// Every sellable module, off; a personal plan turns on its own.
const ALL_SELLABLE_OFF = Object.freeze({ orders: false, payments: false, inventory: false, customers: false, reports: false, imports: false, expenses: false, suppliers: false, production: false, returns: false, household: false, attendance: false, payroll: false, advances: false, budget: false, schedule: false, providers: false, vendors: false, vendorpayments: false, tasks: false, guests: false });
const HOUSEHOLD_MODULES = ["household", "attendance", "payroll", "advances"];
const BABY_MODULES = ["expenses", "budget", "schedule", "providers"];
const BRIDAL_MODULES = ["expenses", "budget", "vendors", "vendorpayments", "tasks", "guests"];
function personalPlan({ id, name, workspace, monthly, sortOrder, users, storage, modules, plus = false }) {
  return {
    id,
    name,
    workspaceTemplateId: workspace,
    recommended: plus,
    sortOrder,
    pricing: { currency: CURRENCY, setupFee: 0, setupFeeIsMinimum: false, monthly, monthlyIsMinimum: false },
    limits: { users, ordersPerMonth: 0, storageBytes: storage, importsPerMonth: 0 },
    modules: { ...ALL_SELLABLE_OFF, ...Object.fromEntries(modules.map((m) => [m, true])) },
    features: { reportsLevel: plus ? "advanced" : "basic", inAppNotifications: true, pushNotifications: plus, googleSheets: false, advancedPermissions: false, workflowCustomization: false, support: plus ? "priority" : "standard" },
  };
}


export const PLAN_SEED = Object.freeze({
  // ---- Distributor (Phase 18.6: each plan belongs to ONE workspace) ----
  starter: {
    id: "starter",
    name: "Starter",
    workspaceTemplateId: "distributor",
    recommended: false,
    sortOrder: 1,
    pricing: {
      currency: CURRENCY,
      setupFee: 499000,
      setupFeeIsMinimum: false,
      monthly: 99000,
      monthlyIsMinimum: false,
    },
    limits: {
      users: 2,
      ordersPerMonth: 500,
      storageBytes: 1 * GB,
      importsPerMonth: 1,
    },
    modules: {
      orders: true,
      payments: true,
      inventory: true,
      customers: true,
      reports: true,
      imports: true,
      expenses: true,
      suppliers: false,
      production: false,
      returns: false,
      // Phase 14 household payroll (operational only in that workspace).
      household: true,
      attendance: true,
      payroll: true,
      advances: true,
      // Phase 15 Baby Expense Tracker (operational only in that workspace).
      budget: true,
      schedule: true,
      providers: true,
      // Phase 16 Bridal / Wedding (operational only in that workspace).
      vendors: true,
      vendorpayments: true,
      tasks: true,
      guests: true,
    },
    features: {
      reportsLevel: "basic",
      inAppNotifications: true,
      pushNotifications: false,
      googleSheets: false,
      advancedPermissions: false,
      workflowCustomization: false,
      support: "standard",
    },
  },

  growth: {
    id: "growth",
    name: "Growth",
    workspaceTemplateId: "distributor",
    recommended: true,
    sortOrder: 2,
    pricing: {
      currency: CURRENCY,
      setupFee: 999000,
      setupFeeIsMinimum: false,
      monthly: 199000,
      monthlyIsMinimum: false,
    },
    limits: {
      users: 5,
      ordersPerMonth: 2000,
      storageBytes: 5 * GB,
      importsPerMonth: 5,
    },
    modules: {
      orders: true,
      payments: true,
      inventory: true,
      customers: true,
      reports: true,
      imports: true,
      expenses: true,
      suppliers: false,
      production: false,
      returns: false,
      // Phase 14 household payroll (operational only in that workspace).
      household: true,
      attendance: true,
      payroll: true,
      advances: true,
      // Phase 15 Baby Expense Tracker (operational only in that workspace).
      budget: true,
      schedule: true,
      providers: true,
      // Phase 16 Bridal / Wedding (operational only in that workspace).
      vendors: true,
      vendorpayments: true,
      tasks: true,
      guests: true,
    },
    features: {
      reportsLevel: "advanced",
      inAppNotifications: true,
      pushNotifications: true,
      googleSheets: true,
      advancedPermissions: false,
      workflowCustomization: false,
      support: "priority",
    },
  },

  pro: {
    id: "pro",
    name: "Pro",
    workspaceTemplateId: "distributor",
    recommended: false,
    sortOrder: 3,
    pricing: {
      currency: CURRENCY,
      setupFee: 1999000,
      setupFeeIsMinimum: true,
      monthly: 299000,
      monthlyIsMinimum: true,
    },
    limits: {
      users: 10,
      ordersPerMonth: 5000,
      storageBytes: 20 * GB,
      importsPerMonth: 20,
    },
    modules: {
      orders: true,
      payments: true,
      inventory: true,
      customers: true,
      reports: true,
      imports: true,
      expenses: true,
      suppliers: false,
      production: false,
      returns: false,
      // Phase 14 household payroll (operational only in that workspace).
      household: true,
      attendance: true,
      payroll: true,
      advances: true,
      // Phase 15 Baby Expense Tracker (operational only in that workspace).
      budget: true,
      schedule: true,
      providers: true,
      // Phase 16 Bridal / Wedding (operational only in that workspace).
      vendors: true,
      vendorpayments: true,
      tasks: true,
      guests: true,
    },
    features: {
      reportsLevel: "advanced",
      inAppNotifications: true,
      pushNotifications: true,
      googleSheets: true,
      advancedPermissions: true,
      workflowCustomization: true,
      support: "priority",
    },
  },

  // ---- Household / Kasambahay, Baby, Bridal / Wedding (Phase 18.6) ----
  // PRICING HYPOTHESES, not final prices. Each plan enables only its own
  // workspace's modules; limits use the shared vocabulary (orders and imports
  // are 0: those modules don't exist in personal workspaces).
  "household-basic": personalPlan({ id: "household-basic", name: "Household Basic", workspace: "household-payroll", monthly: 14900, sortOrder: 11, users: 3, storage: 500 * MB, modules: HOUSEHOLD_MODULES }),
  "household-plus": personalPlan({ id: "household-plus", name: "Household Plus", workspace: "household-payroll", monthly: 29900, sortOrder: 12, users: 6, storage: 2 * GB, modules: HOUSEHOLD_MODULES, plus: true }),
  "baby-basic": personalPlan({ id: "baby-basic", name: "Baby Basic", workspace: "baby-expense", monthly: 14900, sortOrder: 21, users: 2, storage: 500 * MB, modules: BABY_MODULES }),
  "baby-plus": personalPlan({ id: "baby-plus", name: "Baby Plus", workspace: "baby-expense", monthly: 24900, sortOrder: 22, users: 5, storage: 2 * GB, modules: BABY_MODULES, plus: true }),
  "bridal-basic": personalPlan({ id: "bridal-basic", name: "Luna Bridal", workspace: "bridal-expense", monthly: 19900, sortOrder: 31, users: 3, storage: 1 * GB, modules: BRIDAL_MODULES }),
  "bridal-plus": personalPlan({ id: "bridal-plus", name: "Luna Bridal+", workspace: "bridal-expense", monthly: 39900, sortOrder: 32, users: 6, storage: 5 * GB, modules: BRIDAL_MODULES, plus: true }),
});

// The workspace a plan belongs to (older stored plans had none: Distributor).
export const planWorkspace = (plan) => (plan && typeof plan.workspaceTemplateId === "string" ? plan.workspaceTemplateId : "distributor");

// Vocabulary every plan and override is validated against
// (shared/entitlements.js). Adding a limit or feature means adding it here
// and to every plan; nothing else hard-codes these numbers.
export const LIMIT_DEFINITIONS = Object.freeze({
  users: { label: "Active users", unit: "count" },
  ordersPerMonth: { label: "Orders per month", unit: "count" },
  storageBytes: { label: "File storage", unit: "bytes" },
  importsPerMonth: { label: "Spreadsheet imports per month", unit: "count" },
});

export const LIMIT_KEYS = Object.freeze(Object.keys(LIMIT_DEFINITIONS));

export const FEATURE_DEFINITIONS = Object.freeze({
  reportsLevel: { label: "Reports", type: "enum", values: ["basic", "advanced"] },
  inAppNotifications: { label: "In-app notifications", type: "boolean" },
  pushNotifications: { label: "Push notifications", type: "boolean" },
  googleSheets: { label: "Google Sheets sync", type: "boolean" },
  advancedPermissions: { label: "Advanced permissions", type: "boolean" },
  workflowCustomization: { label: "Workflow customization", type: "boolean" },
  support: { label: "Support", type: "enum", values: ["standard", "priority"] },
});

export const FEATURE_KEYS = Object.freeze(Object.keys(FEATURE_DEFINITIONS));

export function isValidFeatureValue(key, value) {
  const def = FEATURE_DEFINITIONS[key];
  if (!def) return false;
  if (def.type === "boolean") return value === true || value === false;
  return def.values.includes(value);
}

export function formatMoney(centavos, { minimum = false } = {}) {
  const pesos = (Number(centavos) || 0) / 100;
  const text = new Intl.NumberFormat("en-PH", { style: "currency", currency: CURRENCY, maximumFractionDigits: 0 }).format(pesos);
  return minimum ? `${text}+` : text;
}
