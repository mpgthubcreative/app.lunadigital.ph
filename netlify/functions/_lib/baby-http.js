// One authenticated action endpoint per Baby module (Phase 15). Each action
// names its permission; requireTenant checks membership, subscription
// (writes need write access), the module's entitlement within the workspace
// template, and the permission, before the body is examined. `also` lists
// extra permissions an action needs (Mark paid also records an expense:
// expenses.create, with the Expenses module).

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./http.js";
import { requireTenant } from "./tenant.js";
import { actorOf, only } from "./inventory-http.js";
import { BabyError } from "../../../shared/baby.js";
import { ExpenseError } from "../../../shared/expenses.js";
import { isModuleEnabled } from "../../../shared/modules.js";
import { moduleForPermission } from "../../../shared/permissions.js";

export const BABY_STATUS = {
  "not-found": 404,
  stale: 409,
  "history-full": 409,
  "duplicate-category": 409,
  "provider-in-use": 409,
  "too-many-categories": 409,
  "category-in-use": 409,
  "not-upcoming": 409,
  "invalid-category": 400,
  "invalid-provider": 400,
  "not-available": 403,
  removed: 409,
};

const FORBIDDEN = () => new RequestError("forbidden", "This feature isn't available for your account.", 403);

// actions: { [name]: { permission, also?, fields, created?, run(common, body, ctx) } }
export function babyActionHandler(name, { getAdmin: loadAdmin, now = () => new Date(), actions }) {
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
    for (const p of action?.also || []) if (ctx.permissions[p] !== true || !isModuleEnabled(ctx.entitlements, moduleForPermission(p))) throw FORBIDDEN();
    if (bodyError) throw bodyError;
    if (!action) throw new RequestError("invalid-request", "Unknown action.", 400);
    only(body, action.fields);
    if (body.expectedRevision !== undefined && !Number.isSafeInteger(body.expectedRevision)) throw new RequestError("invalid-request", "Invalid revision.", 400);
    const common = { db, tenant: ctx.tenant, FieldValue: admin.firestore.FieldValue, business: ctx.business, workspace: ctx.workspace.templateId, actor: actorOf(ctx), now: now() };
    try {
      const out = await action.run(common, body, ctx);
      return respond(action.created ? 201 : 200, { success: true, ...out });
    } catch (err) {
      if (err instanceof BabyError || err instanceof ExpenseError) throw new RequestError(err.code, err.message, BABY_STATUS[err.code] || 400);
      throw err;
    }
  });
}
