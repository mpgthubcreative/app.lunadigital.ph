// GET /api/session
// Headers: Authorization: Bearer <Firebase ID token>
//          X-Luna-Business-Id: <businessId>   (optional selector)
//
// Returns everything the app shell needs to configure itself for the
// signed-in user in ONE business. The browser uses this only to shape the
// UI; every future data endpoint re-resolves the same context itself via
// requireTenant() and never trusts anything the browser echoes back.

import { respond, withErrorHandling, requireMethod } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { authenticate } from "./_lib/auth.js";
import { resolveTenantContext, requestedBusinessId, listActiveMemberships } from "./_lib/tenant.js";
import { readUsageSummary } from "./_lib/usage.js";
import { normalizeEnvironment } from "../../shared/environment.js";

function toIso(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function createSessionHandler({ getAdmin: loadAdmin }) {
  return withErrorHandling("session", async (event) => {
    requireMethod(event, "GET");
    const { db, auth } = await loadAdmin();

    const user = await authenticate(event, auth);
    const context = await resolveTenantContext({ db, uid: user.uid, requestedBusinessId: requestedBusinessId(event) });

    const [memberships, usage] = await Promise.all([
      listActiveMemberships(db, user.uid),
      readUsageSummary(context.tenant, context.business.timezone),
    ]);

    return respond(200, {
      success: true,
      environment: normalizeEnvironment(process.env.LUNA_ENV),
      user: { uid: user.uid, email: user.email, name: user.name },
      business: context.business,
      member: context.member,
      permissions: context.permissions,
      plan: { id: context.entitlements.planId, name: context.entitlements.planName || context.entitlements.planId },
      subscription: {
        status: context.subscription.status,
        renewalAt: toIso(context.subscription.renewalAt),
        graceUntil: toIso(context.subscription.graceUntil),
        access: {
          canRead: context.policy.canRead,
          canWrite: context.policy.canWrite,
          exportOnly: context.policy.exportOnly,
        },
      },
      entitlements: {
        modules: context.entitlements.modules,
        limits: context.entitlements.limits,
        features: context.entitlements.features,
      },
      usage,
      memberships,
    });
  });
}

export const handler = createSessionHandler({ getAdmin });
