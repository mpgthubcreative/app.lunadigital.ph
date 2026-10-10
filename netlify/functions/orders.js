// POST /api/orders   (Orders + Inventory modules, write access, and per action:)
//   { action: "create", idempotencyKey, order: { customer, source, sourceNote?, deliveryAddress?, items: [{ productId, quantity }], discount?, notes? } }   orders.create
//   { action: "update", orderId, expectedRevision?, order: { ...same shape } }                                                     orders.update
//   { action: "fulfill", orderId }                                                                                                 orders.fulfill
//   { action: "cancel", orderId, reason }                                                                                          orders.cancel
//   { action: "delete", orderId, reason? }   accidental open, unpaid order                                                       orders.cancel
// update on a FULFILLED order is a correction: also needs orders.correct, and
// a reason when quantities, products or the discount change.
// A non-zero discount (or changing it) also needs orders.discount.
// Prices, names, totals, stock and costs are never accepted from the
// browser; the server computes them from trusted documents.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { createOrder, updateOrder, fulfillOrder, cancelOrder, deleteOrder, setFulfillmentStage } from "./_lib/orders.js";
import { actorOf, only } from "./_lib/inventory-http.js";
import { OrderError } from "../../shared/orders.js";
import { CustomerError } from "../../shared/customers.js";
import { canUseModule } from "../../shared/modules.js";
import { InventoryError } from "../../shared/inventory.js";
import { QuantityError } from "../../shared/quantity.js";

const ACTIONS = {
  create: { permission: "orders.create", fields: ["action", "idempotencyKey", "order"] },
  // Editing a fulfilled order additionally needs orders.correct (checked in the service).
  update: { permission: "orders.update", fields: ["action", "orderId", "expectedRevision", "order", "reason"] },
  delete: { permission: "orders.cancel", fields: ["action", "orderId", "reason"] },
  fulfill: { permission: "orders.fulfill", fields: ["action", "orderId"] },
  stage: { permission: "orders.fulfill", fields: ["action", "orderId", "stage"] },
  cancel: { permission: "orders.cancel", fields: ["action", "orderId", "reason"] },
};

const STATUS = {
  "not-found": 404,
  "not-pending": 409,
  "stale-order": 409,
  "idempotency-conflict": 409,
  "insufficient-stock": 409,
  "insufficient-reserved": 409,
  "product-inactive": 409,
  "below-paid": 409,
  "history-full": 409,
  "has-payments": 409,
  "invalid-stage": 400,
  "not-deletable": 409,
  "reason-required": 400,
  "order-limit-reached": 403,
  "discount-not-allowed": 403,
  "business-misconfigured": 503,
  "customer-not-allowed": 403,
  "customer-not-found": 409,
  "customer-inactive": 409,
  "invalid-customer": 400,
};

async function mapErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OrderError || err instanceof InventoryError || err instanceof QuantityError || err instanceof CustomerError) {
      throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
    }
    throw err;
  }
}

export function createOrdersHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("orders", async (event) => {
    requireMethod(event, "POST");
    // Authenticate and authorize BEFORE reporting anything about the body.
    let body = null;
    let bodyError = null;
    try {
      body = parseJsonBody(event, 16384);
    } catch (err) {
      bodyError = err;
    }
    const action = (body && ACTIONS[body.action]) || null;
    const { db, auth, admin } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, module: "inventory", permission: action ? action.permission : "orders.view", write: true });
    if (bodyError) throw bodyError;
    if (!action) throw new RequestError("invalid-request", "Unknown action.", 400);
    only(body, action.fields);

    const common = { db, tenant: ctx.tenant, FieldValue: admin.firestore.FieldValue, actor: actorOf(ctx) };
    const canDiscount = ctx.permissions["orders.discount"] === true;
    // Linking an order to a saved customer needs the Customers module and
    // customers.view (keeping an order's existing link doesn't).
    const canLinkCustomers = canUseModule({ entitlements: ctx.entitlements, permissions: ctx.permissions }, "customers");
    const result = await mapErrors(async () => {
      switch (body.action) {
        case "create":
          return createOrder({ ...common, business: ctx.business, entitlements: ctx.entitlements, input: body.order, idempotencyKey: body.idempotencyKey, canDiscount, canLinkCustomers, now: now() });
        case "update":
          if (body.expectedRevision !== undefined && !Number.isSafeInteger(body.expectedRevision)) throw new RequestError("invalid-request", "Invalid revision.", 400);
          return updateOrder({ ...common, business: ctx.business, orderId: body.orderId, input: body.order, expectedRevision: body.expectedRevision ?? null, canDiscount, canLinkCustomers, canCorrect: ctx.permissions["orders.correct"] === true, reason: body.reason ?? null });
        case "stage":
          return setFulfillmentStage({ ...common, orderId: body.orderId, stage: body.stage });
        case "delete":
          return deleteOrder({ ...common, orderId: body.orderId, reason: body.reason ?? null });
        case "fulfill":
          return fulfillOrder({ ...common, business: ctx.business, orderId: body.orderId, now: now() });
        default:
          return cancelOrder({ ...common, business: ctx.business, orderId: body.orderId, reason: body.reason, now: now() });
      }
    });

    const seesFinancials = ctx.permissions["dashboard.financials"] === true;
    // Correction deltas include COGS: only for dashboard.financials.
    const { order, cogs, grossSales, discount, netSales, delta, ...rest } = result;
    return respond(body.action === "create" && !result.replayed ? 201 : 200, {
      success: true,
      ...rest,
      ...(body.action === "fulfill" && seesFinancials ? { financials: { grossSales, discount, netSales, cogs, grossProfit: netSales - cogs } } : {}),
      ...(delta && seesFinancials ? { correction: delta } : {}),
    });
  });
}

export const handler = createOrdersHandler({ getAdmin });
