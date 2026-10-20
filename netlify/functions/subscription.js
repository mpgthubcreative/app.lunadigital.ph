// /api/subscription   (Phase 18.6: the workspace Owner's Luna subscription)
//   GET                                                     billing.view
//     -> plan, status, amount due, billing month, due date, paid through,
//        next renewal, open bills, payment history, Luna's bank details
//   POST { action: "submit", idempotencyKey, payment: { period, amount,
//          paymentDate, reference, method?, note? }, proof: { contentType, dataBase64 } }
//     -> For Verification (a submission never marks anything paid)
//   POST { action: "choose", planId?, termMonths }   Owner: Continue with Luna
//     (a free trial picks its product / term; the first bill is made)
// Only the business's own billing. A past-due or suspended subscription can
// still PAY (no write-access check on submit); verifying is Luna's job
// (/api/operator), never the tenant's.

import { respond, withErrorHandling, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { tenantSubscription, submitPayment, conversionBill, assertNoPendingPayment } from "./_lib/billing.js";
import { chooseConversion, ProvisioningError } from "./_lib/provisioning.js";
import { BillingError } from "../../shared/billing.js";

const STATUS = { "payment-pending": 409, "invalid-input": 400, "invalid-proof": 400, "proof-required": 400, "no-invoice": 404, "already-paid": 409, "not-found": 404, "not-in-trial": 409, "plan-wrong-workspace": 400, "unknown-plan": 400, "stale": 409 };
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
      if (body?.action === "choose") {
        // Continue with Luna: the Owner only (works after the trial ended too).
        if (ctx.member?.isAccountOwner !== true && ctx.member?.roleTemplate !== "owner") throw new RequestError("forbidden", "Only the owner can choose a plan.", 403);
        for (const k of Object.keys(body)) if (!["action", "planId", "termMonths"].includes(k)) throw new RequestError("invalid-request", `Unknown field ${k}.`, 400);
        if (body.planId !== undefined && (typeof body.planId !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(body.planId))) throw new RequestError("invalid-request", "Unknown plan.", 400);
        const actor = ctx.user.email || ctx.user.uid;
        await assertNoPendingPayment({ db, businessId: ctx.businessId });
        const r = await chooseConversion({ db, admin, businessId: ctx.businessId, planId: body.planId ?? null, termMonths: body.termMonths, actor, now: now() });
        return respond(200, { success: true, planId: r.planId, invoice: await conversionBill({ db, FieldValue, businessId: ctx.businessId, operator: actor }) });
      }
      if (!body || body.action !== "submit") throw new RequestError("invalid-request", "Unknown action.", 400);
      for (const k of Object.keys(body)) if (!["action", "idempotencyKey", "payment", "proof"].includes(k)) throw new RequestError("invalid-request", `Unknown field ${k}.`, 400);
      const actor = { uid: ctx.user.uid, name: ctx.member?.name ?? ctx.user.name ?? null, email: ctx.user.email ?? null };
      const r = await submitPayment({ db, bucket, FieldValue, businessId: ctx.businessId, actor, input: body.payment, proof: body.proof, idempotencyKey: body.idempotencyKey, now: now() });
      return respond(201, { success: true, ...r });
    } catch (err) {
      if (err instanceof BillingError || err instanceof ProvisioningError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createSubscriptionHandler({ getAdmin });
