// GET /api/usage   (Phase 18; members with billing.view, normally the Owner)
// The last 12 months of this business's usage, newest first, from
// shared/metering.js historyRows: a month with no usage document is "no
// recorded usage" (nulls), never zeros; counters not metered yet that month
// are null too. Running totals (file storage, active users) are current
// values, never presented as monthly totals.

import { respond, withErrorHandling, requireMethod } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { readUsageHistory, readCurrentUsage } from "./_lib/metering.js";

export function createUsageHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("usage", async (event) => {
    requireMethod(event, "GET");
    const { db, auth } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, permission: "billing.view" });
    const at = now();
    const [history, current] = await Promise.all([readUsageHistory(ctx.tenant, ctx.business.timezone, { months: 12, now: at }), readCurrentUsage(ctx.tenant, ctx.business.timezone, at)]);
    return respond(200, { success: true, timezone: ctx.business.timezone, period: current.period, current: current.values, storage: current.storage, limits: ctx.entitlements.limits, history });
  });
}

export const handler = createUsageHandler({ getAdmin });
