// One authenticated action endpoint per payroll module (Phase 14). Each
// action names its permission; requireTenant checks membership,
// subscription (writes need write access), the module's entitlement within
// the workspace template, and the permission, before the body is examined.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./http.js";
import { requireTenant } from "./tenant.js";
import { actorOf, only } from "./inventory-http.js";
import { PayrollError } from "../../../shared/payroll.js";
import { ProvisioningError } from "./provisioning.js";
import { ActivationError } from "./activation.js";
import { PaymentError } from "../../../shared/payments.js";
import { MeteringError } from "../../../shared/metering.js";
import { isModuleEnabled } from "../../../shared/modules.js";
import { moduleForPermission } from "../../../shared/permissions.js";

export const PAYROLL_STATUS = {
  "not-found": 404,
  "has-draft-payroll": 409,
  "staff-in-use": 409,
  "payroll-released": 409,
  "advance-paid": 409,
  "inactive-staff": 409,
  "period-not-ended": 409,
  "negative-net-pay": 409,
  "receipt-not-awaited": 409,
  "too-many-deductions": 409,
  "advance-deduction": 409,
  "history-full": 409,
  // Phase 18.6
  "request-decided": 409,
  "advance-not-approved": 409,
  "too-many-requests": 409,
  "not-linked": 403,
  "has-login": 409,
  "no-login": 409,
  "login-disabled": 409,
  "already-member": 409,
  "login-id-busy": 503,
  "user-limit-reached": 403,
  "owner-protected": 403,
  "thirteenth-over": 409,
  "payment-not-paid": 409,
  "receipt-confirmed": 409,
  "has-proof": 409,
  "no-dispute": 409,
  "proof-too-large": 413,
  "storage-limit-reached": 409,
};
const FORBIDDEN = () => new RequestError("forbidden", "This feature isn't available for your account.", 403);

// actions: { [name]: { permission, also?, fields, run(common, body, ctx) -> { status?, result } } }
// `also`: extra permissions the action needs (each with its module), e.g.
// creating a staff login also needs users.manage.
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
    const { db, auth, admin, bucket } = await loadAdmin();
    const first = Object.values(actions)[0];
    const ctx = await requireTenant(event, { db, auth, permission: action ? action.permission : first.permission, write: true });
    for (const p of action?.also || []) if (ctx.permissions[p] !== true || !isModuleEnabled(ctx.entitlements, moduleForPermission(p))) throw FORBIDDEN();
    if (bodyError) throw bodyError;
    if (!action) throw new RequestError("invalid-request", "Unknown action.", 400);
    only(body, action.fields);
    const common = { db, admin, auth, bucket, tenant: ctx.tenant, businessId: ctx.businessId, FieldValue: admin.firestore.FieldValue, business: ctx.business, actor: actorOf(ctx), now: now() };
    try {
      const out = await action.run(common, body, ctx);
      return respond(action.created ? 201 : 200, { success: true, ...out });
    } catch (err) {
      if (err instanceof PayrollError || err instanceof ProvisioningError || err instanceof ActivationError || err instanceof PaymentError || err instanceof MeteringError) throw new RequestError(err.code, err.message, PAYROLL_STATUS[err.code] || 400);
      throw err;
    }
  });
}
