// POST /api/reseller-menu   PUBLIC (no login): a reseller's private menu,
// /reseller#{token}. The token travels in the POST body; Luna knows the
// reseller from it (they never pick their own name).
//   { action: "view", token }                       products (owner price, their
//                                                   selling price), their commission
//                                                   and their own orders
//   { action: "setPrice", token, productId, price } their selling price (>= owner price)
//   { action: "order", token, idempotencyKey, order: { customerName, customerPhone?,
//       fulfillment, address?, paymentMethod?, notes?, items: [{ productId, quantity, sellingPrice }] } }
//   { action: "payLink", token, orderNumber }       the customer's payment link for
//                                                   one of THEIR orders
// Every bad, revoked, regenerated or inactive link gets one answer
// (./_lib/resellers.js). Payments go through the order's payment link and
// stay "for verification" until the Owner verifies them.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { viewResellerMenu, setResellerPrice, placeResellerOrder, resellerOrderPayLink } from "./_lib/resellers.js";
import { ResellerError } from "../../shared/resellers.js";
import { MeteringError } from "../../shared/metering.js";

const FIELDS = { view: ["action", "token"], setPrice: ["action", "token", "productId", "price"], order: ["action", "token", "idempotencyKey", "order"], payLink: ["action", "token", "orderNumber"] };
const STATUS = { "link-not-found": 404, "not-found": 404, "sold-out": 409, "below-owner-price": 409, "idempotency-conflict": 409 };

export function createResellerMenuHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("reseller-menu", async (event) => {
    requireMethod(event, "POST");
    const body = parseJsonBody(event);
    const fields = body && typeof body === "object" && !Array.isArray(body) ? FIELDS[body.action] : null;
    if (!fields || Object.keys(body).some((k) => !fields.includes(k)) || typeof body.token !== "string") throw new RequestError("invalid-request", "Invalid request.", 400);
    const { db, admin } = await loadAdmin();
    try {
      if (body.action === "view") return respond(200, { success: true, ...(await viewResellerMenu({ db, token: body.token })) });
      if (body.action === "setPrice") return respond(200, { success: true, ...(await setResellerPrice({ db, token: body.token, productId: body.productId, price: body.price, now: now() })) });
      if (body.action === "payLink") return respond(200, { success: true, ...(await resellerOrderPayLink({ db, token: body.token, orderNumber: body.orderNumber, now: now() })) });
      const r = await placeResellerOrder({ db, FieldValue: admin.firestore.FieldValue, token: body.token, idempotencyKey: body.idempotencyKey, input: body.order, now: now() });
      return respond(r.replayed ? 200 : 201, { success: true, ...r });
    } catch (err) {
      if (err instanceof ResellerError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      if (err instanceof MeteringError) throw new RequestError("unavailable", "The business can't take orders right now. Please message them.", 503);
      throw err;
    }
  });
}

export const handler = createResellerMenuHandler({ getAdmin });
