// GET /api/household-summary   (Phase 18.6: the Household Dashboard; payroll.view)
// The next cutoff's total salary to pay and one row per active staff member
// (estimated net, advance to deduct, payment and receipt status), plus the
// number of staff requests waiting. Computed by the server from the stored
// records (./_lib/household-summary.js); nothing is stored.

import { respond, withErrorHandling, requireMethod } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { householdSummary } from "./_lib/household-summary.js";

export function createHouseholdSummaryHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("household-summary", async (event) => {
    requireMethod(event, "GET");
    const { db, auth } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, permission: "payroll.view" });
    return respond(200, { success: true, summary: await householdSummary({ db, tenant: ctx.tenant, business: ctx.business, now: now() }) });
  });
}

export const handler = createHouseholdSummaryHandler({ getAdmin });
