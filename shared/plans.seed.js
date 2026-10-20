// Plan configuration (final pricing model, 2026-10-21).
//
// ONE public product per workspace, plus Bridal's Custom service. Every
// product but Custom starts with a 30-day FREE TRIAL (pricing.trialDays;
// a trial is a state, never a bill: shared/trial.js).
//   Luna Household       6 months ₱1,299 · 12 months ₱2,390 (Best Value);
//                        no monthly option, no setup fee; 1 paid
//                        family/admin user, 500 MB
//   Luna Distributor     6 months ₱1,299 · 12 months ₱2,390 (Best Value)
//                        + ₱250 one-time setup (first paid bill only); no
//                        monthly option; 2 users, 500 MB
//   Luna Bridal          ₱1,490 one-time for 12 months; 1 planner, 500 MB,
//                        standard website invitation
//   Luna Bridal Custom   starting at ₱2,990 / 12 months; customized website
//                        invitation + designer work (plan id bridal-plus,
//                        kept: the invitation level is tied to it)
//   (Baby keeps its two plans.)
// Product, term and add-ons are separate (shared/plan-billing.js): the
// terms and add-ons are data here, edited in Super Admin → Plans. Customers
// add capacity only when they need it (add-ons), never a "+" plan.
// Commercial limits are users and storage only (no order limit; imports
// aren't launched). A kasambahay login never uses a Household seat; wedding
// guests aren't users. Distributor+ / Luna Household+ and Starter / Growth /
// Pro are LEGACY: hidden, kept only so businesses already on them stay valid.
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
// No commercial limit (shared/plan-billing.js UNLIMITED): shown as "No limit".
const NO_LIMIT = 1_000_000;

const GB = 1024 ** 3;
const MB = 1024 ** 2;

// Every sellable module, off; a personal plan turns on its own.
const ALL_SELLABLE_OFF = Object.freeze({ orders: false, payments: false, inventory: false, customers: false, reports: false, imports: false, expenses: false, suppliers: false, production: false, returns: false, household: false, attendance: false, payroll: false, advances: false, budget: false, schedule: false, providers: false, vendors: false, vendorpayments: false, tasks: false, guests: false });
// Luna Household: payroll + household money (Expenses, Budget, Bills).
const HOUSEHOLD_MODULES = ["household", "attendance", "payroll", "advances", "expenses", "budget", "schedule", "grocery"];
const BABY_MODULES = ["expenses", "budget", "schedule", "providers"];
const BRIDAL_MODULES = ["expenses", "budget", "vendors", "vendorpayments", "tasks", "guests"];
// pricing: `monthly` stays the RECURRING monthly price (0 for prepaid /
// term plans, so they never count as recurring income); `billingType`,
// `price` (the main offer), `termMonths`, `terms`, `addOns` and `autoRenew`
// describe how the product is sold (shared/plan-billing.js planBilling).
// `tagline`: what the product does for the customer, in one line.
function personalPlan({ id, name, workspace, monthly = 0, sortOrder, users, storage, modules, plus = false, billing = null, tagline = null, legacy = false }) {
  return {
    id,
    name,
    ...(legacy ? { legacy: true } : {}),
    ...(tagline ? { tagline } : {}),
    workspaceTemplateId: workspace,
    // The main product of the workspace (Bridal: Standard; Baby: Plus).
    recommended: !legacy && (billing ? !plus : plus),
    sortOrder,
    pricing: billing
      ? { currency: CURRENCY, setupFee: 0, setupFeeIsMinimum: false, monthly: 0, monthlyIsMinimum: false, ...billing }
      : { currency: CURRENCY, setupFee: 0, setupFeeIsMinimum: false, monthly, monthlyIsMinimum: false },
    limits: { users, ordersPerMonth: 0, storageBytes: storage, importsPerMonth: 0 },
    modules: { ...ALL_SELLABLE_OFF, ...Object.fromEntries(modules.map((m) => [m, true])) },
    features: { reportsLevel: plus ? "advanced" : "basic", inAppNotifications: true, pushNotifications: plus, googleSheets: false, advancedPermissions: false, workflowCustomization: false, support: plus ? "priority" : "standard" },
  };
}

// Distributor: monthly + ₱999 setup; users and storage only, no order limit.
const DISTRIBUTOR_MODULES = ["orders", "payments", "inventory", "customers", "reports", "imports", "expenses"];
function distributorPlan({ id, name, sortOrder, price, users, storage, plus = false, legacy = false, terms = null, addOns = [], tagline = null, billing = null }) {
  return {
    id,
    name,
    ...(legacy ? { legacy: true } : {}),
    ...(tagline ? { tagline } : {}),
    workspaceTemplateId: "distributor",
    recommended: !legacy,
    sortOrder,
    pricing: billing
      ? { currency: CURRENCY, setupFeeIsMinimum: false, monthly: 0, monthlyIsMinimum: false, addOns, ...billing }
      : { currency: CURRENCY, setupFee: 99900, setupFeeIsMinimum: false, monthly: price, monthlyIsMinimum: false, billingType: "monthly", price, termMonths: 1, autoRenew: true, terms: terms ?? [{ months: 1, price, kind: "main" }], addOns },
    limits: { users, ordersPerMonth: NO_LIMIT, storageBytes: storage, importsPerMonth: 0 },
    modules: { ...ALL_SELLABLE_OFF, ...Object.fromEntries(DISTRIBUTOR_MODULES.map((m) => [m, true])) },
    features: { reportsLevel: plus ? "advanced" : "basic", inAppNotifications: true, pushNotifications: plus, googleSheets: false, advancedPermissions: false, workflowCustomization: false, support: plus ? "priority" : "standard" },
  };
}

export const PLAN_SEED = Object.freeze({
  // ---- Distributor (sold) ----
  "distributor-basic": distributorPlan({
    id: "distributor-basic",
    name: "Luna Distributor",
    tagline: "See your orders, customers, stock, payments, costs and profit in one place.",
    sortOrder: 1,
    price: 239000,
    users: 2,
    storage: 500 * MB,
    // Prepaid access (6 or 12 months), renewing; ₱250 setup on the first paid bill.
    billing: {
      billingType: "annual",
      price: 239000,
      termMonths: 12,
      autoRenew: true,
      setupFee: 25000,
      trialDays: 30,
      terms: [{ months: 6, price: 129900, kind: "main" }, { months: 12, price: 239000, kind: "main", label: "Best Value" }],
    },
    addOns: [{ id: "users", label: "+2 users", users: 2, price: 14900, perMonths: 1 }, { id: "storage", label: "+1 GB storage", storageMb: 1024, price: 9900, perMonths: 1 }],
  }),
  // LEGACY (2026-10-19 catalog): capacity is an add-on now.
  "distributor-plus": distributorPlan({ id: "distributor-plus", name: "Distributor+", sortOrder: 104, price: 89900, users: 4, storage: 1 * GB, plus: true, legacy: true }),

  // ---- Distributor, LEGACY (Phase 18.6 plans; hidden, kept for existing businesses) ----
  starter: {
    id: "starter",
    legacy: true,
    name: "Starter",
    workspaceTemplateId: "distributor",
    recommended: false,
    sortOrder: 101,
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
    legacy: true,
    name: "Growth",
    workspaceTemplateId: "distributor",
    recommended: true,
    sortOrder: 102,
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
    legacy: true,
    name: "Pro",
    workspaceTemplateId: "distributor",
    recommended: false,
    sortOrder: 103,
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
  // Household: annual access. Users = paid household / family seats (a
  // kasambahay's own login never uses one).
  "household-basic": personalPlan({
    id: "household-basic",
    name: "Luna Household",
    tagline: "Know what to pay your kasambahay, what bills are due, and where your household money went.",
    workspace: "household-payroll",
    sortOrder: 11,
    users: 1,
    storage: 500 * MB,
    modules: HOUSEHOLD_MODULES,
    billing: {
      billingType: "annual",
      price: 239000,
      termMonths: 12,
      autoRenew: true,
      trialDays: 30,
      terms: [{ months: 6, price: 129900, kind: "main" }, { months: 12, price: 239000, kind: "main", label: "Best Value" }],
      addOns: [{ id: "user", label: "Additional family/admin user", users: 1, price: 19900, perMonths: 12 }, { id: "storage", label: "Additional 500 MB storage", storageMb: 500, price: 19900, perMonths: 12 }],
    },
  }),
  // LEGACY (2026-10-19 catalog): capacity is an add-on now.
  "household-plus": personalPlan({ id: "household-plus", name: "Luna Household+", workspace: "household-payroll", sortOrder: 112, users: 3, storage: 1 * GB, modules: HOUSEHOLD_MODULES, plus: true, legacy: true, billing: { billingType: "annual", price: 199000, termMonths: 12, autoRenew: true, terms: [{ months: 12, price: 199000, kind: "main" }] } }),
  "baby-basic": personalPlan({ id: "baby-basic", name: "Baby Basic", workspace: "baby-expense", monthly: 14900, sortOrder: 21, users: 2, storage: 500 * MB, modules: BABY_MODULES }),
  "baby-plus": personalPlan({ id: "baby-plus", name: "Baby Plus", workspace: "baby-expense", monthly: 24900, sortOrder: 22, users: 5, storage: 2 * GB, modules: BABY_MODULES, plus: true }),
  // Bridal: 12-month wedding access only (no trials), bought once, no
  // automatic renewal. Users = planning users (guests and invitation
  // visitors aren't users). Extra capacity: Super Admin limit overrides.
  "bridal-basic": personalPlan({
    id: "bridal-basic",
    name: "Luna Bridal",
    tagline: "Your wedding planner, RSVP tracker and website invitation for the whole year.",
    workspace: "bridal-expense",
    sortOrder: 31,
    users: 1,
    storage: 500 * MB,
    modules: BRIDAL_MODULES,
    billing: { billingType: "term", price: 149000, termMonths: 12, autoRenew: false, trialDays: 30, terms: [{ months: 12, price: 149000, kind: "main" }] },
  }),
  // Luna Bridal Custom: the customized invitation website + designer work
  // (a service, not a bigger limit). "Starting at": the price follows the
  // design scope (Super Admin price override).
  "bridal-plus": personalPlan({
    id: "bridal-plus",
    name: "Luna Bridal Custom",
    tagline: "Your wedding planning system with a customized invitation website designed for your wedding.",
    workspace: "bridal-expense",
    sortOrder: 32,
    users: 1,
    storage: 500 * MB,
    modules: BRIDAL_MODULES,
    plus: true,
    billing: { billingType: "term", price: 299000, priceIsMinimum: true, termMonths: 12, autoRenew: false, terms: [{ months: 12, price: 299000, kind: "main" }] },
  }),
});

// The workspace a plan belongs to (older stored plans had none: Distributor).
export const planWorkspace = (plan) => (plan && typeof plan.workspaceTemplateId === "string" ? plan.workspaceTemplateId : "distributor");
// The plans Super Admin offers (create, change plan, Plans page); legacy ones stay valid but hidden.
export const isCatalogPlan = (plan) => Boolean(plan) && plan.legacy !== true;

// Vocabulary every plan and override is validated against
// (shared/entitlements.js). Adding a limit or feature means adding it here
// and to every plan; nothing else hard-codes these numbers.
export const LIMIT_DEFINITIONS = Object.freeze({
  users: { label: "Active users", unit: "count" },
  ordersPerMonth: { label: "Orders per month", unit: "count" },
  storageBytes: { label: "File storage", unit: "bytes" },
  // Imports aren't launched: kept in the vocabulary, never shown.
  importsPerMonth: { label: "Spreadsheet imports per month", unit: "count", hidden: true },
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
