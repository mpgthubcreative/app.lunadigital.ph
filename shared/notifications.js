// Luna Notifications Core (Phase 13): the shared vocabulary.
//
//   event -> rule (NOTIFICATION_TYPES) -> recipients -> channels -> read state
//
// A trusted server-side business event (a payment recorded, a stock
// movement, an order stage change) asks for a notification by type. The
// rule says which module it belongs to and which permissions a recipient
// needs; the server resolves recipients from ACTIVE memberships, their
// stored permission maps, the business's entitlements (module + the plan's
// inAppNotifications feature) and each member's preferences. The browser
// never decides that a notification exists.
//
// Workspace-agnostic: a rule is gated by its module, so a template without
// Inventory (Bridal, Payroll, Baby) can never receive a low-stock alert.
// Future templates add their own types here (salary due, task overdue,
// supplier payment due, RSVP deadline, budget threshold, ...) with their
// own modules; scheduled producers ("due tomorrow") are a later addition
// that calls the same server API from a scheduled function.
//
// Channels: in-app is the record of truth. Email and web push are
// architected (preferences + per-notification delivery state) but not
// delivered yet; see docs/ARCHITECTURE.md "Notifications".

import { isModuleEnabled } from "./modules.js";
import { ID } from "./list-queries.js";

export const NOTIFICATION_SCHEMA_VERSION = 1;
export const NOTIFICATIONS_PERMISSION = "notifications.view";

// Delivery channels. Only in-app is delivered in Phase 13.
export const NOTIFICATION_CHANNELS = Object.freeze({
  inApp: { label: "In-app", delivered: true },
  email: { label: "Email", delivered: false }, // needs an approved email provider
  push: { label: "Browser push", delivered: false }, // needs FCM + a service worker
});

// Preference categories. `mandatory`: in-app can't be switched off (the
// item needs someone's action and nothing else surfaces it).
export const NOTIFICATION_CATEGORIES = Object.freeze({
  payments: { label: "Payments awaiting verification", mandatory: true },
  inventory: { label: "Low stock", mandatory: false },
  orders: { label: "Orders ready", mandatory: false },
  payroll: { label: "Salary receipt confirmations", mandatory: false },
  budget: { label: "Budget alerts (75%, 90%, 100% used)", mandatory: false },
  wedding: { label: "Supplier payments recorded", mandatory: false },
});
export const NOTIFICATION_CATEGORY_IDS = Object.freeze(Object.keys(NOTIFICATION_CATEGORIES));

// Rules. `permissions`: ALL needed by a recipient (besides
// notifications.view). `excludeActor`: the person who caused the event
// isn't told about it. `route`: a convenience link only; the destination
// enforces its own access like any navigation.
export const NOTIFICATION_TYPES = Object.freeze({
  "payment.awaiting_verification": {
    category: "payments",
    module: "payments",
    permissions: ["payments.view", "payments.verify"],
    excludeActor: true,
    action: { label: "Review payment", route: "/payments" },
  },
  "inventory.low_stock": {
    category: "inventory",
    module: "inventory",
    permissions: ["inventory.view", "inventory.receive"],
    excludeActor: false,
    action: { label: "View inventory", route: "/inventory" },
  },
  // Phase 14: the employee confirmed receiving their salary (public link).
  "payroll.receipt_confirmed": {
    category: "payroll",
    module: "payroll",
    permissions: ["payroll.view"],
    excludeActor: false,
    action: { label: "View payroll", route: "/payroll" },
  },
  // Phase 15: the Baby budget reached 75 / 90 / 100% used. One per level
  // per budget episode (event key "<episode>-<level>"), never per expense.
  "budget.threshold": {
    category: "budget",
    module: "budget",
    permissions: ["budget.view"],
    excludeActor: false,
    action: { label: "View budget", route: "/budget" },
  },
  // Phase 16: a supplier payment was marked Paid (its Wedding Expense was
  // recorded). Goes to the OTHER members who follow supplier payments.
  "supplierpayment.paid": {
    category: "wedding",
    module: "vendorpayments",
    permissions: ["vendorpayments.view"],
    excludeActor: true,
    action: { label: "View supplier payments", route: "/supplier-payments" },
  },
  "order.ready": {
    category: "orders",
    module: "orders",
    permissions: ["orders.view", "orders.fulfill"],
    excludeActor: true,
    action: { label: "View order", route: "/orders" },
  },
});
export const NOTIFICATION_TYPE_IDS = Object.freeze(Object.keys(NOTIFICATION_TYPES));

// Notifications are a core capability (Dashboard is in every workspace),
// switched on by the plan's inAppNotifications feature.
export function notificationsEnabled(entitlements) {
  return isModuleEnabled(entitlements, "dashboard") && entitlements?.features?.inAppNotifications === true;
}

export function canUseNotifications({ entitlements, permissions }) {
  return notificationsEnabled(entitlements) && permissions?.[NOTIFICATIONS_PERMISSION] === true;
}

// Is this (member, business) a recipient for `type` right now?
// member: { status, permissions, notificationPreferences }.
export function isEligibleRecipient(type, { entitlements, member }) {
  const rule = NOTIFICATION_TYPES[type];
  if (!rule || !member || member.status !== "active") return false;
  const perms = member.permissions;
  if (!perms || typeof perms !== "object") return false;
  if (!canUseNotifications({ entitlements, permissions: perms })) return false;
  if (!isModuleEnabled(entitlements, rule.module)) return false;
  if (!rule.permissions.every((p) => perms[p] === true)) return false;
  return wantsChannel(member.notificationPreferences, rule.category, "inApp");
}

// May this user still follow a notification's link? (Rules for its type,
// against the CURRENT session; the destination checks again.)
export function canFollowNotification(n, { entitlements, permissions }) {
  const rule = NOTIFICATION_TYPES[n?.type];
  return Boolean(rule) && isModuleEnabled(entitlements, rule.module) && rule.permissions.every((p) => permissions?.[p] === true);
}

// Preferences: { [category]: { inApp?: bool } }. Missing = default on.
// Mandatory categories are always on in-app.
export function wantsChannel(preferences, category, channel) {
  const def = NOTIFICATION_CATEGORIES[category];
  if (!def) return false;
  if (channel === "inApp" && def.mandatory) return true;
  if (channel !== "inApp") return preferences?.[category]?.[channel] === true; // opt-in channels
  return preferences?.[category]?.inApp !== false;
}

export class NotificationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Validates a preferences change from the browser: only known, optional
// categories and the in-app channel; booleans only.
export function validatePreferences(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new NotificationError("invalid-preferences", "Invalid preferences");
  const out = {};
  for (const [category, value] of Object.entries(input)) {
    const def = NOTIFICATION_CATEGORIES[category];
    if (!def) throw new NotificationError("invalid-preferences", `Unknown category ${category}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotificationError("invalid-preferences", "Invalid preferences");
    for (const [channel, on] of Object.entries(value)) {
      if (channel !== "inApp") throw new NotificationError("invalid-preferences", `The ${channel} channel isn't available yet`);
      if (typeof on !== "boolean") throw new NotificationError("invalid-preferences", "Preferences are on/off");
      if (def.mandatory && !on) throw new NotificationError("mandatory-notification", `${def.label} can't be switched off`);
    }
    out[category] = { ...value };
  }
  return out;
}

// Deterministic notification id for (type, event key): the same event can
// only ever produce one notification per recipient (retries, races).
const SAFE = /[^A-Za-z0-9_-]/g;
export function notificationId(type, eventKey) {
  if (!NOTIFICATION_TYPES[type]) throw new Error(`Unknown notification type ${type}`);
  if (typeof eventKey !== "string" || !eventKey) throw new Error("A notification needs an event key");
  return `${type.replace(SAFE, "_")}__${eventKey.replace(SAFE, "_")}`.slice(0, 200);
}

// The browser's list query (shared spec, like shared/list-queries.js):
// newest first (id breaks ties: one event can notify about several
// products at the same instant); optional unread-only and category filters.
export const NOTIFICATION_PAGE_SIZE = 20;
export const NOTIFICATION_RECENT = 8;
export function notificationsQuery({ unread = false, category = "" } = {}) {
  const where = [];
  if (unread) where.push(["read", "==", false]);
  if (category) where.push(["category", "==", category]);
  return { parts: [{ where, orderBy: [["createdAt", "desc"], [ID, "desc"]] }] };
}
