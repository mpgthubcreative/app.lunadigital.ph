// One authenticated action endpoint per payroll module (Phase 14). Each
// action names its permission; requireTenant checks membership,
// subscription (writes need write access), the module's entitlement within
// the workspace template, and the permission, before the body is examined.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./http.js";
import { requireTenant } from "./tenant.js";
import { actorOf, only } from "./inventory-http.js";
import { PayrollError } from "../../../shared/payroll.js";

export const PAYROLL_STATUS = {
  "not-found": 404,
  "has-draft-payroll": 409,
  "payroll-released": 409,
  "advance-paid": 409,
  "inactive-staff": 409,
  "period-not-ended": 409,
  "negative-net-pay": 409,
  "receipt-not-awaited": 409,
  "too-many-deductions": 409,
  "advance-deduction": 409,
  "history-full": 409,
};

// actions: { [name]: { permission, fields, run(common, body, ctx) -> { status?, result } } }
export function payrollActionHandler(name, { getAdmin: loadAdmin, now = () => new Date(), actions }) {
  return withErrorHandling(name, async (event) => {
    requireMethod(event, "POST");
    let body = null;
    let bodyError = null;
    try {
      body = parseJsonBody(event);
    } catch (err) {
      bodyError = err;
    }
    const action = body && Object.prototype.hasOwnProperty.call(actions, body.action) ? actions[body.action] : null;
    const { db, auth, admin } = await loadAdmin();
    const first = Object.values(actions)[0];
    const ctx = await requireTenant(event, { db, auth, permission: action ? action.permission : first.permission, write: true });
    if (bodyError) throw bodyError;
    if (!action) throw new RequestError("invalid-request", "Unknown action.", 400);
    only(body, action.fields);
    const common = { db, tenant: ctx.tenant, FieldValue: admin.firestore.FieldValue, business: ctx.business, actor: actorOf(ctx), now: now() };
    try {
      const out = await action.run(common, body, ctx);
      return respond(action.created ? 201 : 200, { success: true, ...out });
    } catch (err) {
      if (err instanceof PayrollError) throw new RequestError(err.code, err.message, PAYROLL_STATUS[err.code] || 400);
      throw err;
    }
  });
}
