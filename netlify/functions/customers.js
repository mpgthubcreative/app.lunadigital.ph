// POST /api/customers   (Customers module; writes need subscription write access)
//   { action: "create", customer: { name, company?, phone?, email?, address?, notes? } }   customers.manage
//   { action: "update", customerId, expectedRevision?, changes: { ...any of the above } }  customers.manage
//   { action: "setStatus", customerId, status: "active" | "inactive" }                      customers.manage
//   { action: "delete", customerId, reason? }   (never-ordered customers only)             customers.manage
// Order statistics on a customer are never accepted from the browser; they
// move with the orders and payments themselves. Reads go straight to
// Firestore under the rules (customers.view).

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { createCustomer, updateCustomer, setCustomerStatus, deleteCustomer } from "./_lib/customers.js";
import { actorOf, only } from "./_lib/inventory-http.js";
import { CustomerError } from "../../shared/customers.js";

const ACTIONS = {
  create: ["action", "customer"],
  update: ["action", "customerId", "expectedRevision", "changes"],
  setStatus: ["action", "customerId", "status"],
  delete: ["action", "customerId", "reason"],
};

const STATUS = {
  "not-found": 404,
  "invalid-customer": 400,
  "stale-customer": 409,
  "has-orders": 409,
  "history-full": 409,
};

export function createCustomersHandler({ getAdmin: loadAdmin }) {
  return withErrorHandling("customers", async (event) => {
    requireMethod(event, "POST");
    // Authenticate and authorize BEFORE reporting anything about the body.
    let body = null;
    let bodyError = null;
    try {
      body = parseJsonBody(event);
    } catch (err) {
      bodyError = err;
    }
    const { db, auth, admin } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, permission: "customers.manage", write: true });
    if (bodyError) throw bodyError;
    const fields = body && ACTIONS[body.action];
    if (!fields) throw new RequestError("invalid-request", "Unknown action.", 400);
    only(body, fields);

    const common = { db, tenant: ctx.tenant, FieldValue: admin.firestore.FieldValue, actor: actorOf(ctx) };
    try {
      switch (body.action) {
        case "create":
          return respond(201, { success: true, ...(await createCustomer({ ...common, input: body.customer })) });
        case "update":
          return respond(200, { success: true, ...(await updateCustomer({ ...common, customerId: body.customerId, changes: body.changes, expectedRevision: body.expectedRevision ?? null })) });
        case "setStatus":
          return respond(200, { success: true, ...(await setCustomerStatus({ ...common, customerId: body.customerId, status: body.status })) });
        default:
          return respond(200, { success: true, ...(await deleteCustomer({ ...common, customerId: body.customerId, reason: body.reason ?? null })) });
      }
    } catch (err) {
      if (err instanceof CustomerError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createCustomersHandler({ getAdmin });
