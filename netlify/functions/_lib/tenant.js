// Tenant context resolution — the server-side answer to "which business is
// this request for, and what may this user do there?".
//
// A businessId from the browser (X-Luna-Business-Id) is ONLY a selector.
// Access is granted solely by an ACTIVE membership document at
// businesses/{businessId}/members/{uid}, read here with the Admin SDK for
// the uid proven by the verified ID token. Role names are never consulted
// for authorization: the stored, server-written permission map is.

import { RequestError } from "./http.js";
import { authenticate } from "./auth.js";
import { tenantDb } from "./tenant-db.js";
import { accessPolicy } from "../../../shared/subscription.js";
import { isModuleEnabled } from "../../../shared/modules.js";
import { ROLE_TEMPLATES } from "../../../shared/permissions.js";
import { isValidBusinessId, effectivePermissions, BUSINESS_SELECTOR_HEADER } from "../../../shared/tenancy.js";

// One message for "doesn't exist" and "not a member" so a caller can't
// probe which business ids exist.
const ACCESS_DENIED = () => new RequestError("business-access-denied", "You don't have access to this business.", 403);

export function requestedBusinessId(event) {
  const headers = event.headers || {};
  const raw = headers[BUSINESS_SELECTOR_HEADER] ?? headers["X-Luna-Business-Id"];
  if (raw === undefined || raw === null || raw === "") return null;
  if (!isValidBusinessId(raw)) {
    throw new RequestError("invalid-business", "Invalid business selection.", 400);
  }
  return raw;
}

function hasValidEntitlements(entitlements, planId) {
  return Boolean(
    entitlements &&
      entitlements.planId === planId &&
      entitlements.modules &&
      typeof entitlements.modules === "object" &&
      entitlements.limits &&
      typeof entitlements.limits === "object"
  );
}

// Evaluates one candidate business. Returns { ok: true, context } or
// { ok: false, error } — never throws for access problems so the caller
// can try the next candidate when no business was explicitly requested.
async function evaluateCandidate(db, uid, businessId) {
  const tenant = tenantDb(db, businessId);
  const [memberSnap, businessSnap] = await Promise.all([tenant.member(uid).get(), tenant.ref.get()]);

  if (!memberSnap.exists || !businessSnap.exists) return { ok: false, error: ACCESS_DENIED() };

  const member = memberSnap.data();
  const business = businessSnap.data();

  if (member.status !== "active") {
    return { ok: false, error: new RequestError("membership-disabled", "Your access to this business has been disabled. Contact the business owner.", 403) };
  }

  const subscription = business.subscription || {};
  const policy = accessPolicy(subscription.status);
  if (!policy.canRead) {
    return { ok: false, error: new RequestError("subscription-inactive", "This business account is not active. Please contact Luna support.", 403) };
  }
  if (policy.ownerOnly && member.isAccountOwner !== true) {
    return { ok: false, error: new RequestError("account-cancelled", "This business account has been cancelled. Only the owner can sign in to export data.", 403) };
  }

  if (!hasValidEntitlements(business.entitlements, subscription.planId)) {
    console.error(`resolveTenantContext: business ${businessId} has missing/stale entitlements`);
    return { ok: false, error: new RequestError("business-misconfigured", "This business isn't set up correctly yet. Please contact Luna support.", 503) };
  }

  const roleTemplate = member.roleTemplate || null;
  return {
    ok: true,
    context: {
      uid,
      businessId,
      tenant,
      business: {
        id: businessId,
        name: business.name || "",
        timezone: business.timezone || "UTC",
        currency: business.currency || "PHP",
      },
      member: {
        roleTemplate,
        // Display only — authorization uses `permissions` below.
        roleLabel: (roleTemplate && ROLE_TEMPLATES[roleTemplate]?.label) || "Custom",
        isAccountOwner: member.isAccountOwner === true,
        status: member.status,
      },
      permissions: effectivePermissions(member.permissions, policy),
      subscription: {
        planId: subscription.planId,
        status: subscription.status,
        renewalAt: subscription.renewalAt || null,
        graceUntil: subscription.graceUntil || null,
      },
      policy,
      entitlements: business.entitlements,
    },
  };
}

// Resolves the tenant for a verified uid.
// - requestedBusinessId given → that business or an error (no fallback).
// - not given → the user's default business, then their other businesses,
//   first one with an active, readable membership.
export async function resolveTenantContext({ db, uid, requestedBusinessId: requested }) {
  if (requested) {
    const result = await evaluateCandidate(db, uid, requested);
    if (!result.ok) throw result.error;
    return result.context;
  }

  const userSnap = await db.collection("users").doc(uid).get();
  const profile = userSnap.exists ? userSnap.data() : {};
  const candidates = [...new Set([profile.defaultBusinessId, ...(Array.isArray(profile.businessIds) ? profile.businessIds : [])])].filter(isValidBusinessId);

  let firstError = null;
  for (const businessId of candidates) {
    const result = await evaluateCandidate(db, uid, businessId);
    if (result.ok) return result.context;
    firstError = firstError || result.error;
  }

  if (firstError && firstError.code !== "business-access-denied") throw firstError;
  throw new RequestError("no-active-membership", "Your account isn't linked to an active Luna business.", 403);
}

// One-call guard for tenant endpoints:
//   const ctx = await requireTenant(event, { db, auth, permission: "orders.create", module: "orders", write: true });
export async function requireTenant(event, { db, auth, permission = null, module = null, write = false }) {
  const user = await authenticate(event, auth);
  const context = await resolveTenantContext({ db, uid: user.uid, requestedBusinessId: requestedBusinessId(event) });
  context.user = user;

  if (module && !isModuleEnabled(context.entitlements, module)) {
    throw new RequestError("module-disabled", "This feature isn't enabled for your business.", 403);
  }
  if (permission && context.permissions[permission] !== true) {
    throw new RequestError("forbidden", "You don't have permission to do that.", 403);
  }
  if (write && !context.policy.canWrite) {
    throw new RequestError("read-only", "This account is read-only. Changes are disabled.", 403);
  }
  return context;
}

// Lists the businesses a user can switch between (active memberships
// only). Each entry is confirmed against its membership document — the
// users/{uid}.businessIds index alone is never trusted.
export async function listActiveMemberships(db, uid) {
  const userSnap = await db.collection("users").doc(uid).get();
  const ids = userSnap.exists && Array.isArray(userSnap.data().businessIds) ? userSnap.data().businessIds.filter(isValidBusinessId) : [];

  const rows = await Promise.all(
    ids.map(async (businessId) => {
      const tenant = tenantDb(db, businessId);
      const [memberSnap, businessSnap] = await Promise.all([tenant.member(uid).get(), tenant.ref.get()]);
      if (!memberSnap.exists || !businessSnap.exists || memberSnap.data().status !== "active") return null;
      const roleTemplate = memberSnap.data().roleTemplate;
      return {
        businessId,
        businessName: businessSnap.data().name || "",
        roleLabel: (roleTemplate && ROLE_TEMPLATES[roleTemplate]?.label) || "Custom",
      };
    })
  );
  return rows.filter(Boolean);
}
