// POST /api/pay   PUBLIC (no login): an order's payment link, /pay/{token}.
//   { action: "view", token }   the business name, order number, the name on
//                               the order, total / paid / awaiting / due, the
//                               payment instructions and this order's payments
//                               (receipts for verified ones)
//   { action: "submit", token, idempotencyKey, payment: { amount, method, reference? },
//       proof?: { contentType, dataBase64 }, website? }
//                               ONE payment "for verification" (GCash / Maya /
//                               bank transfer; a screenshot or the reference)
// The token travels in the POST body. Every bad, revoked or foreign link
// gets one answer (./_lib/pay-links.js). `website` is a hidden form field
// people never fill. Submits are rate-limited per client and per link.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { viewPayLink, submitPayLink } from "./_lib/pay-links.js";
import { clientKeyOf } from "./_lib/storefront.js";
import { PaymentError } from "../../shared/payments.js";
import { MeteringError } from "../../shared/metering.js";

const STATUS = {
  "link-not-found": 404,
  "order-cancelled": 409,
  "nothing-due": 409,
  overpayment: 409,
  "duplicate-reference": 409,
  "too-many-payments": 429,
  "proof-too-large": 413,
  "storage-limit-reached": 409,
  "business-misconfigured": 503,
};
// Base64 screenshots (<= 2.5 MB decoded) fit well inside this.
const MAX_BODY = 4_500_000;

export function createPayHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("pay", async (event) => {
    requireMethod(event, "POST");
    const body = parseJsonBody(event, MAX_BODY);
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : null;
    // host: the custom workspace address the page is on (2026-10-26).
    const allowed = body?.action === "view" ? ["action", "token", "host"] : ["action", "token", "idempotencyKey", "payment", "proof", "website", "host"];
    if (!keys || !["view", "submit"].includes(body.action) || keys.some((k) => !allowed.includes(k)) || typeof body.token !== "string" || ("host" in body && typeof body.host !== "string")) {
      throw new RequestError("invalid-request", "Invalid request.", 400);
    }
    const { db, admin, bucket } = await loadAdmin();
    try {
      const host = typeof body.host === "string" ? body.host.toLowerCase() : null;
      if (body.action === "view") return respond(200, { success: true, ...(await viewPayLink({ db, token: body.token, host })) });
      if (body.website !== undefined && body.website !== "") throw new PaymentError("invalid-input", "Please refresh the page and try again.");
      const r = await submitPayLink({ db, bucket, FieldValue: admin.firestore.FieldValue, token: body.token, idempotencyKey: body.idempotencyKey, input: body.payment, proof: body.proof ?? null, clientKey: clientKeyOf(event), now: now(), host });
      return respond(r.alreadyRecorded ? 200 : 201, { success: true, ...r });
    } catch (err) {
      if (err instanceof PaymentError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      // A plan limit is the business's matter, not the customer's.
      if (err instanceof MeteringError) throw new RequestError("unavailable", "This business can't take online payments right now. Please message them directly.", 503);
      throw err;
    }
  });
}

export const handler = createPayHandler({ getAdmin });
