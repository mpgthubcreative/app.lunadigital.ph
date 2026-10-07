// INITIAL plan configuration — not validated final pricing.
//
// This file is the seed for the Firestore `plans/{planId}` collection,
// which becomes the editable source of truth (Super Admin, Phase 13). Code
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

export const LIMIT_KEYS = Object.freeze(["users", "ordersPerMonth", "storageBytes", "importsPerMonth"]);

export function formatMoney(centavos, { minimum = false } = {}) {
  const pesos = (Number(centavos) || 0) / 100;
  const text = new Intl.NumberFormat("en-PH", { style: "currency", currency: CURRENCY, maximumFractionDigits: 0 }).format(pesos);
  return minimum ? `${text}+` : text;
}
