// Tenancy vocabulary shared by browser and server: business id format,
// membership statuses, permission sanitization, and the effective
// permissions a member gets under their business's subscription policy.

import { isPermissionKey } from "./permissions.js";

// Business ids are opaque path segments (Firestore document ids). The
// format check is input hygiene only — it never grants access. Access is
// always decided by reading businesses/{id}/members/{uid} server-side.
const BUSINESS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

export function isValidBusinessId(value) {
  return typeof value === "string" && BUSINESS_ID_PATTERN.test(value);
}

export const MEMBER_STATUSES = Object.freeze(["active", "disabled"]);

// Header the browser uses to say WHICH of its businesses a request is for.
// It is a selector, never a credential.
export const BUSINESS_SELECTOR_HEADER = "x-luna-business-id";

// Keeps only known permission keys whose value is exactly true. A stored
// map with a typo, a stale key, or a truthy non-boolean grants nothing.
export function sanitizePermissions(map) {
  const result = {};
  if (!map || typeof map !== "object") return result;
  for (const [key, value] of Object.entries(map)) {
    if (value === true && isPermissionKey(key)) result[key] = true;
  }
  return result;
}

// What a cancelled (export-only) account may still do.
const EXPORT_ONLY_PERMISSIONS = Object.freeze(["dashboard.view", "reports.view", "reports.export", "billing.view", "settings.view"]);

// Narrows a member's permissions by the subscription access policy.
// Write restrictions for suspended accounts are enforced separately by
// policy.canWrite on every write endpoint; the permission map itself only
// shrinks for export-only (cancelled) accounts.
export function effectivePermissions(permissions, policy) {
  const clean = sanitizePermissions(permissions);
  if (!policy || !policy.canRead) return {};
  if (!policy.exportOnly) return clean;
  const narrowed = {};
  for (const key of EXPORT_ONLY_PERMISSIONS) {
    if (clean[key]) narrowed[key] = true;
  }
  return narrowed;
}
