// POST /api/payments   (Payments module; writes also need subscription write access)
//   { action: "record", orderId, payment: { amount, method, reference?, note? }, proof?: { contentType, dataBase64 } }   payments.record
//   { action: "update", paymentId, changes: { amount?, method?, reference?, note? }, proof? }                          payments.verify
//   { action: "verify", paymentId }                                                                                    payments.verify
//   { action: "void", paymentId, reason }                                                                              payments.verify
//   { action: "proof", paymentId }  -> { contentType, dataBase64 }   (read only)                                       payments.view
// amount is integer centavos. A payment recorded by someone with
// payments.verify is verified at once; otherwise it's "for verification".
// amountPaid / balance / status are always derived on the server.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { recordPayment, updatePayment, verifyPayment, voidPayment, readProof } from "./_lib/payments.js";
import { actorOf, only } from "./_lib/inventory-http.js";
import { PaymentError } from "../../shared/payments.js";

const ACTIONS = {
  record: { permission: "payments.record", write: true, fields: ["action", "orderId", "payment", "proof"] },
  update: { permission: "payments.verify", write: true, fields: ["action", "paymentId", "changes", "proof"] },
  verify: { permission: "payments.verify", write: true, fields: ["action", "paymentId"] },
  void: { permission: "payments.verify", write: true, fields: ["action", "paymentId", "reason"] },
  proof: { permission: "payments.view", write: false, fields: ["action", "paymentId"] },
};

const STATUS = {
  "not-found": 404,
  "no-proof": 404,
  "duplicate-reference": 409,
  overpayment: 409,
  "order-cancelled": 409,
  voided: 409,
  "not-pending-verification": 409,
  "history-full": 409,
  inconsistent: 409,
  "proof-too-large": 413,
};

// Base64 screenshots (<= 2.5 MB decoded) fit well inside this.
const MAX_BODY = 4_500_000;

export function createPaymentsHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("payments", async (event) => {
    requireMethod(event, "POST");
    // Authenticate and authorize BEFORE reporting anything about the body.
    let body = null;
    let bodyError = null;
    try {
      body = parseJsonBody(event, MAX_BODY);
    } catch (err) {
      bodyError = err;
    }
    const action = (body && ACTIONS[body.action]) || null;
    const { db, auth, admin, bucket } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, permission: action ? action.permission : "payments.view", write: action ? action.write : false });
    if (bodyError) throw bodyError;
    if (!action) throw new RequestError("invalid-request", "Unknown action.", 400);
    only(body, action.fields);

    const common = { db, bucket, tenant: ctx.tenant, FieldValue: admin.firestore.FieldValue, business: ctx.business, actor: actorOf(ctx) };
    try {
      switch (body.action) {
        case "record":
          return respond(201, { success: true, ...(await recordPayment({ ...common, orderId: body.orderId, input: body.payment, proof: body.proof ?? null, canVerify: ctx.permissions["payments.verify"] === true, now: now() })) });
        case "update":
          return respond(200, { success: true, ...(await updatePayment({ ...common, paymentId: body.paymentId, changes: body.changes, proof: body.proof ?? null })) });
        case "verify":
          return respond(200, { success: true, ...(await verifyPayment({ ...common, paymentId: body.paymentId })) });
        case "void":
          return respond(200, { success: true, ...(await voidPayment({ ...common, paymentId: body.paymentId, reason: body.reason })) });
        default:
          return respond(200, { success: true, ...(await readProof({ tenant: ctx.tenant, bucket, businessId: ctx.business.id, paymentId: body.paymentId })) });
      }
    } catch (err) {
      if (err instanceof PaymentError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createPaymentsHandler({ getAdmin });
