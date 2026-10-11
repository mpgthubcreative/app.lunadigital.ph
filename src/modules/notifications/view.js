// Pure display helpers for notifications (bell drawer + Notifications page).

import { NOTIFICATION_CATEGORIES, NOTIFICATION_TYPES, canFollowNotification, isEligibleRecipient } from "@shared/notifications.js";

const toDate = (at) => (at instanceof Date ? at : at && typeof at.toDate === "function" ? at.toDate() : at && typeof at.seconds === "number" ? new Date(at.seconds * 1000) : null);

// "just now", "5 min ago", "3 h ago", "yesterday", then a date.
export function ago(at, now = new Date(), timezone = "Asia/Manila") {
  const d = toDate(at);
  if (!d) return "";
  const s = Math.max(0, Math.round((now - d) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return "yesterday";
  return new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", timeZone: timezone }).format(d);
}

// A route a notification may link to: an internal path of a known rule only.
// Owner-pilot batch: a staff request opens the approval list filtered to
// that person (attendance: the staff id is the first part of the request's
// record id; an advance request: its id, which the Advances page resolves).
const safeRoute = (n) => {
  const route = NOTIFICATION_TYPES[n.type]?.action.route;
  if (typeof route !== "string" || !/^\/[a-z-]*$/.test(route)) return null;
  const staff = n.type === "household.attendance_request" ? /^([A-Za-z0-9]{8,40})_\d{4}-\d{2}-\d{2}$/.exec(typeof n.recordId === "string" ? n.recordId : "")?.[1] : null;
  if (staff) return `${route}?staff=${staff}`;
  const advance = n.type === "household.advance_request" && typeof n.recordId === "string" && /^[A-Za-z0-9]{8,40}$/.test(n.recordId) ? n.recordId : null;
  return advance ? `${route}?advance=${advance}` : route;
};

export function notificationRow(n, session, now = new Date()) {
  const access = { entitlements: session.entitlements, permissions: session.member.permissions };
  const followable = canFollowNotification(n, access) && Boolean(safeRoute(n));
  return {
    id: n.id,
    title: n.title,
    message: n.message,
    time: ago(n.createdAt, now, session.business.timezone),
    category: NOTIFICATION_CATEGORIES[n.category]?.label ?? n.category,
    unread: n.read !== true,
    resolved: n.resolved === true,
    status: n.resolved === true ? "Resolved" : n.read === true ? "Read" : "Unread",
    // Links only while the user can still open the destination (which
    // checks again on its own); otherwise the row says so.
    action: followable ? { label: NOTIFICATION_TYPES[n.type].action.label, route: safeRoute(n) } : null,
  };
}

// The categories this user can receive (for filters and preferences).
export function myCategories(session) {
  const member = { status: "active", permissions: session.member.permissions, notificationPreferences: {} };
  const out = new Set();
  for (const [type, rule] of Object.entries(NOTIFICATION_TYPES)) if (isEligibleRecipient(type, { entitlements: session.entitlements, member })) out.add(rule.category);
  return [...out];
}

export const badgeText = (count) => (count > 99 ? "99+" : String(count));
