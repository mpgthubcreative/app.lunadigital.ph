// Subscription states and what each one allows. Enforcement happens in
// Firestore rules (reads) and Netlify Functions (writes); this is the one
// definition both, plus the UI, derive from.
//
// No state ever deletes data. Cancelled accounts keep their data under the
// (future) retention policy; the owner can still sign in to export.

export const SUBSCRIPTION_STATUSES = Object.freeze(["active", "past_due", "suspended", "cancelled"]);

const POLICIES = Object.freeze({
  active: { canRead: true, canWrite: true, ownerOnly: false, exportOnly: false, banner: null },
  past_due: { canRead: true, canWrite: true, ownerOnly: false, exportOnly: false, banner: "warning" },
  suspended: { canRead: true, canWrite: false, ownerOnly: false, exportOnly: false, banner: "danger" },
  cancelled: { canRead: true, canWrite: false, ownerOnly: true, exportOnly: true, banner: "danger" },
});

// Unknown/missing status fails closed: no reads, no writes.
const DENY_ALL = Object.freeze({ canRead: false, canWrite: false, ownerOnly: true, exportOnly: true, banner: "danger" });

export function accessPolicy(status) {
  return POLICIES[status] || DENY_ALL;
}
