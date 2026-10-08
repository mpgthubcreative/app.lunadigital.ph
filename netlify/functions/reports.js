// GET /api/reports?from=YYYY-MM-DD&to=YYYY-MM-DD   (Reports module + reports.view)
//
// Business-local days, inclusive at both ends, at most 366 days, never past
// the business's today. The business is ALWAYS the caller's resolved tenant
// (requireTenant); no query parameter can select another one, and nothing
// else is accepted (no cursors, no filters). Each section is included only
// when its source module is on and the caller holds that module's view
// permission; money (sales, COGS, profit, payment / unpaid amounts) is only
// computed and returned with dashboard.financials. Read-only, so it also
// works while suspended.

import { respond, withErrorHandling, requireMethod, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { buildReport } from "./_lib/reports.js";
import { validateRange, ReportError } from "../../shared/reports.js";
import { businessDate } from "../../shared/metrics.js";

const PARAMS = ["from", "to"];

export function createReportsHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("reports", async (event) => {
    requireMethod(event, "GET");
    const { db, auth } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, permission: "reports.view" });

    const q = event.queryStringParameters || {};
    for (const k of Object.keys(q)) if (!PARAMS.includes(k)) throw new RequestError("invalid-request", `Unknown parameter ${k}.`, 400);
    let range;
    try {
      range = validateRange({ from: q.from, to: q.to }, businessDate(ctx.business.timezone, now()));
    } catch (err) {
      if (err instanceof ReportError) throw new RequestError(err.code, err.message, 400);
      throw err;
    }
    const report = await buildReport({ db, tenant: ctx.tenant, from: range.from, to: range.to, permissions: ctx.permissions, entitlements: ctx.entitlements });
    return respond(200, { success: true, ...report });
  });
}

export const handler = createReportsHandler({ getAdmin });
