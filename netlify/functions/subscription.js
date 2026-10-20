// /api/subscription   (Phase 18.6: the workspace Owner's Luna subscription)
//   GET                                                     billing.view
//     -> plan, status, amount due, billing month, due date, paid through,
//        next renewal, open bills, payment history, Luna's bank details
//   POST { action: "submit", idempotencyKey, payment: { period, amount,
//          paymentDate, reference, method?, note? }, proof: { contentType, dataBase64 } }
//     -> For Verification (a submission never marks anything paid)
// Only the business's own billing. A past-due or suspended subscription can
// still PAY (no write-access check on submit); verifying is Luna's job
// (/api/operator), never the tenant's.

import { respond, withErrorHandling, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { tenantSubscription, submitPayment } from "./_lib/billing.js";
import { BillingError } from "../../shared/billing.js";

const STATUS = { "invalid-input": 400, "invalid-proof": 400, "proof-required": 400, "no-invoice": 404, "already-paid": 409, "not-found": 404 };
const MAX_BODY = 4_600_000; // a 3 MB proof, base64-encoded, plus the form

export function createSubscriptionHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("subscription", async (event) => {
    const { db, auth, admin, bucket } = await loadAdmin();
    const FieldValue = admin.firestore.FieldValue;
    try {
      if (event.httpMethod === "GET") {
        const ctx = await requireTenant(event, { db, auth, permission: "billing.view" });
        return respond(200, { success: true, subscription: await tenantSubscription({ db, FieldValue, businessId: ctx.businessId, now: now() }) });
      }
      if (event.httpMethod !== "POST") throw new RequestError("method-not-allowed", "Method not allowed.", 405);
      const ctx = await requireTenant(event, { db, auth, permission: "billing.view" });
      const body = parseJsonBody(event, MAX_BODY);
      if (!body || body.action !== "submit") throw new RequestError("invalid-request", "Unknown action.", 400);
      for (const k of Object.keys(body)) if (!["action", "idempotencyKey", "payment", "proof"].includes(k)) throw new RequestError("invalid-request", `Unknown field ${k}.`, 400);
      const actor = { uid: ctx.user.uid, name: ctx.member?.name ?? ctx.user.name ?? null, email: ctx.user.email ?? null };
      const r = await submitPayment({ db, bucket, FieldValue, businessId: ctx.businessId, actor, input: body.payment, proof: body.proof, idempotencyKey: body.idempotencyKey, now: now() });
      return respond(201, { success: true, ...r });
    } catch (err) {
      if (err instanceof BillingError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createSubscriptionHandler({ getAdmin });
