// POST /api/store   PUBLIC (no login): a business's menu link, /store/{slug}.
//   { action: "view", slug }                                  the store (name,
//                       open, note, pickup / delivery, payment choices) and
//                       its visible active products (name, category, unit,
//                       price, sold out / "only N left")
//   { action: "order", slug, idempotencyKey, order: { name, phone,
//       fulfillment, address?, paymentMethod?, notes?, items: [{ productId, quantity }] }, website? }
//                       ONE normal Luna order (source "Online store"),
//                       created by the same order engine as staff orders
// The slug resolves to exactly one business (./_lib/storefront.js); an
// unknown, moved or unavailable store gets one answer. Prices, names and
// totals always come from the business's products. `website` is a hidden
// form field people never fill: a request that fills it is dropped. Orders
// are rate-limited per client and per store.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { viewStore, placePublicOrder, clientKeyOf } from "./_lib/storefront.js";
import { StorefrontError } from "../../shared/storefront.js";

const STATUS = { "store-not-found": 404, "store-closed": 409, "sold-out": 409, "store-unavailable": 503, "too-many-orders": 429, "invalid-input": 400, "invalid-quantity": 400 };

export function createStoreHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("store", async (event) => {
    requireMethod(event, "POST");
    const body = parseJsonBody(event, 12000);
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : null;
    const allowed = body?.action === "view" ? ["action", "slug"] : ["action", "slug", "idempotencyKey", "order", "website"];
    if (!keys || !["view", "order"].includes(body.action) || keys.some((k) => !allowed.includes(k)) || typeof body.slug !== "string") {
      throw new RequestError("invalid-request", "Invalid request.", 400);
    }
    const { db, admin } = await loadAdmin();
    try {
      if (body.action === "view") return respond(200, { success: true, ...(await viewStore({ db, slug: body.slug })) });
      // The trap field: people never see it, so anything in it is a bot.
      if (body.website !== undefined && body.website !== "") throw new StorefrontError("invalid-input", "Please refresh the page and try again.");
      const order = await placePublicOrder({ db, FieldValue: admin.firestore.FieldValue, slug: body.slug, idempotencyKey: body.idempotencyKey, input: body.order, clientKey: clientKeyOf(event), now: now() });
      return respond(order.replayed ? 200 : 201, { success: true, order });
    } catch (err) {
      if (err instanceof StorefrontError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createStoreHandler({ getAdmin });
