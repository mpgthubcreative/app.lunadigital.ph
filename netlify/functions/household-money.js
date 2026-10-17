// GET /api/household-money?month=YYYY-MM   (Luna Household: budget.view)
// One month of household money: spent (expenses + salaries paid), bills
// remaining, payroll due, budget and what's left, by category. Computed
// from the stored records (./_lib/household-money.js); nothing is stored.

import { respond, withErrorHandling, requireMethod, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { householdMonth } from "./_lib/household-money.js";

export function createHouseholdMoneyHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("household-money", async (event) => {
    requireMethod(event, "GET");
    const { db, auth } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, permission: "budget.view" });
    if (ctx.workspace.templateId !== "household-payroll") throw new RequestError("not-available", "This is for Luna Household.", 403);
    const month = event.queryStringParameters?.month || null;
    try {
      return respond(200, { success: true, month: await householdMonth({ db, tenant: ctx.tenant, business: ctx.business, uid: ctx.uid, month, now: now() }) });
    } catch (err) {
      if (err.code === "invalid-input") throw new RequestError("invalid-input", err.message, 400);
      throw err;
    }
  });
}

export const handler = createHouseholdMoneyHandler({ getAdmin });
