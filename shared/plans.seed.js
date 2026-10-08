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

const GB = 1024 ** 3;

export const CURRENCY = "PHP";

export const PLAN_SEED = Object.freeze({
  starter: {
    id: "starter",
    name: "Starter",
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
});

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
