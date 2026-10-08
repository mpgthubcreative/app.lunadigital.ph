// GET /api/reports
//
// Phase 4: authorization skeleton only. Report generation is Phase 11.
// It exists so the Reports access rule (membership + reports.view + the
// Reports module entitlement) is enforced and tested on a real endpoint
// before any report data exists. An authorized caller gets 501
// not-implemented; nobody gets data.

import { respond, withErrorHandling, requireMethod } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";

export function createReportsHandler({ getAdmin: loadAdmin }) {
  return withErrorHandling("reports", async (event) => {
    requireMethod(event, "GET");
    const { db, auth } = await loadAdmin();
    await requireTenant(event, { db, auth, permission: "reports.view" });
    return respond(501, { success: false, error: "not-implemented", message: "Reports arrive in a later release." });
  });
}

export const handler = createReportsHandler({ getAdmin });
