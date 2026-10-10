// GET /api/session
// Headers: Authorization: Bearer <Firebase ID token>
//          X-Luna-Business-Id: <businessId>   (optional selector)
//
// Returns everything the app shell needs to configure itself for the
// signed-in user in ONE business. The browser uses this only to shape the
// UI; every future data endpoint re-resolves the same context itself via
// requireTenant() and never trusts anything the browser echoes back.
//
// Commercial details (plan name, limits, usage) are returned only to
// members holding billing.view. Everyone gets the module switches and
// feature flags, which the UI needs to build navigation.

import { respond, withErrorHandling, requireMethod } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { authenticate } from "./_lib/auth.js";
import { resolveTenantContext, requestedBusinessId, listActiveMemberships } from "./_lib/tenant.js";
import { readUsageSummary } from "./_lib/usage.js";
import { normalizeEnvironment } from "../../shared/environment.js";
import { resolveTenantConfig, TENANT_CONFIG_DOC_ID } from "../../shared/tenant-config.js";

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

    const seesPackage = context.permissions["billing.view"] === true;
    const [memberships, usage, configSnap] = await Promise.all([
      listActiveMemberships(db, user.uid),
      seesPackage ? readUsageSummary(context.tenant, context.business.timezone) : null,
      // Tenant configuration (Phase 17): cosmetic, fail-safe (defaults when missing / unknown).
      context.tenant.doc("settings", TENANT_CONFIG_DOC_ID).get(),
    ]);

    return respond(200, {
      success: true,
      environment: normalizeEnvironment(process.env.LUNA_ENV),
      user: { uid: user.uid, email: user.email, name: user.name },
      business: context.business,
      workspace: context.workspace,
      member: context.member,
      permissions: context.permissions,
      plan: seesPackage ? { id: context.entitlements.planId, name: context.entitlements.planName } : null,
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
        workspaceTemplateId: context.workspace.templateId,
        workspaceTemplateVersion: context.workspace.templateVersion,
        modules: context.entitlements.modules,
        features: context.entitlements.features,
        limits: seesPackage ? context.entitlements.limits : null,
      },
      usage,
      memberships,
      config: resolveTenantConfig(configSnap.exists ? configSnap.data() : null, context.workspace.templateId),
    });
  });
}

export const handler = createSessionHandler({ getAdmin });
