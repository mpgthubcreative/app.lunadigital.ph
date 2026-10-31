// POST /api/resellers   (Reseller Package; Owner / Admin)
//   { action: "list" }                                        resellers.view
//   { action: "detail", resellerId }                          resellers.view
//   { action: "report", from, to }                            resellers.view
//   { action: "create", reseller: { name, notes? } }          resellers.manage
//   { action: "update", resellerId, changes: { name?, notes? } }   resellers.manage
//   { action: "setStatus", resellerId, status }               resellers.manage
//   { action: "link", resellerId, rotate? }                   resellers.manage   (Copy / Regenerate)
//   { action: "pay", resellerId, idempotencyKey, payout: { amount, date?, method?, reference?, notes? } }   resellers.pay
//   { action: "reversePayout", payoutId, reason }             resellers.pay
//   { action: "editSale", orderId, resellerId?, prices?, finalCommission?, expectedRevision? }   resellers.pay
// Every reseller record is server-only (the rules deny clients). Commission
// figures are never accepted from the browser: they come from the orders.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { actorOf, only } from "./_lib/inventory-http.js";
import { listResellers, resellerDetail, resellerReport, createReseller, updateReseller, setResellerStatus, resellerLink, payCommission, reversePayout } from "./_lib/resellers.js";
import { editResellerSale } from "./_lib/orders.js";
import { ResellerError } from "../../shared/resellers.js";
import { OrderError } from "../../shared/orders.js";

const ACTIONS = {
  list: { fields: ["action"], permission: "resellers.view" },
  detail: { fields: ["action", "resellerId"], permission: "resellers.view" },
  report: { fields: ["action", "from", "to"], permission: "resellers.view" },
  create: { fields: ["action", "reseller"], permission: "resellers.manage", write: true },
  update: { fields: ["action", "resellerId", "changes"], permission: "resellers.manage", write: true },
  setStatus: { fields: ["action", "resellerId", "status"], permission: "resellers.manage", write: true },
  link: { fields: ["action", "resellerId", "rotate"], permission: "resellers.manage", write: true },
  pay: { fields: ["action", "resellerId", "idempotencyKey", "payout"], permission: "resellers.pay", write: true },
  reversePayout: { fields: ["action", "payoutId", "reason"], permission: "resellers.pay", write: true },
  editSale: { fields: ["action", "orderId", "resellerId", "prices", "finalCommission", "expectedRevision"], permission: "resellers.pay", write: true },
};

const STATUS = {
  "not-found": 404,
  "reseller-not-found": 404,
  "too-many": 409,
  "commission-overpaid": 409,
  "commission-below-paid": 409,
  "below-owner-price": 409,
  "below-paid": 409,
  "reseller-inactive": 409,
  "stale-order": 409,
  "not-pending": 409,
};

export function createResellersHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("resellers", async (event) => {
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
    const spec = body && Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
    const ctx = await requireTenant(event, { db, auth, permission: spec?.permission ?? "resellers.view", write: Boolean(spec?.write) });
    if (bodyError) throw bodyError;
    if (!spec) throw new RequestError("invalid-request", "Unknown action.", 400);
    only(body, spec.fields);
    const common = { db, tenant: ctx.tenant, FieldValue: admin.firestore.FieldValue, actor: actorOf(ctx) };
    try {
      switch (body.action) {
        case "list":
          return respond(200, { success: true, resellers: await listResellers(common) });
        case "detail":
          return respond(200, { success: true, ...(await resellerDetail({ ...common, resellerId: body.resellerId })) });
        case "report":
          return respond(200, { success: true, report: await resellerReport({ ...common, from: body.from, to: body.to }) });
        case "create":
          return respond(201, { success: true, ...(await createReseller({ ...common, input: body.reseller, now: now() })) });
        case "update":
          return respond(200, { success: true, ...(await updateReseller({ ...common, resellerId: body.resellerId, changes: body.changes })) });
        case "setStatus":
          return respond(200, { success: true, ...(await setResellerStatus({ ...common, resellerId: body.resellerId, status: body.status })) });
        case "link":
          return respond(200, { success: true, ...(await resellerLink({ ...common, resellerId: body.resellerId, rotate: body.rotate === true, now: now() })) });
        case "pay": {
          const r = await payCommission({ ...common, business: ctx.business, resellerId: body.resellerId, input: body.payout, idempotencyKey: body.idempotencyKey, now: now() });
          return respond(r.alreadyRecorded ? 200 : 201, { success: true, ...r });
        }
        case "reversePayout":
          return respond(200, { success: true, ...(await reversePayout({ ...common, payoutId: body.payoutId, reason: body.reason, now: now() })) });
        case "editSale":
          return respond(200, { success: true, ...(await editResellerSale({ ...common, orderId: body.orderId, ...("resellerId" in body ? { resellerId: body.resellerId } : {}), prices: body.prices ?? null, ...("finalCommission" in body ? { finalCommission: body.finalCommission } : {}), expectedRevision: body.expectedRevision ?? null, now: now() })) });
        default:
          throw new RequestError("invalid-request", "Unknown action.", 400);
      }
    } catch (err) {
      if (err instanceof ResellerError || err instanceof OrderError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createResellersHandler({ getAdmin });
