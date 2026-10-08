// POST /api/inventory   (Inventory module + write access, and per action:)
//   { action: "receipt",  productId, quantity, unitCost, reference?, note? }            inventory.receive
//   { action: "opening",  productId, quantity, unitCost, reference?, note }             inventory.adjust
//   { action: "adjustment_increase" | "adjustment_decrease",
//     productId, quantity, reason, note?, reference? }                                  inventory.adjust
// quantity: scaled integer (shared/quantity.js); unitCost: integer centavos.
// The server computes every balance and the moving average; the browser
// only names the action. Reservations, releases and fulfillment are not
// available here: they belong to Orders (Phase 7, server code only).

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { recordMovement } from "./_lib/inventory.js";
import { actorOf, only, optionalText, mapInventoryErrors } from "./_lib/inventory-http.js";
import { ADJUSTMENT_REASONS } from "../../shared/inventory.js";
import { costUnitsToCentavos } from "../../shared/quantity.js";

const ACTIONS = {
  receipt: { permission: "inventory.receive", fields: ["action", "productId", "quantity", "unitCost", "reference", "note"] },
  opening: { permission: "inventory.adjust", fields: ["action", "productId", "quantity", "unitCost", "reference", "note"] },
  adjustment_increase: { permission: "inventory.adjust", fields: ["action", "productId", "quantity", "reason", "note", "reference"] },
  adjustment_decrease: { permission: "inventory.adjust", fields: ["action", "productId", "quantity", "reason", "note", "reference"] },
};

function movementFrom(body) {
  const reference = optionalText(body.reference, "Reference", 80);
  const note = optionalText(body.note, "Note", 300);
  const movement = { type: body.action, quantity: body.quantity, note, referenceType: reference ? "manual" : null, referenceId: reference };
  if (body.action === "receipt" || body.action === "opening") movement.unitCost = body.unitCost;
  if (body.action === "opening") {
    if (!reference && !note) throw new RequestError("invalid-request", "An opening balance needs a reference or a note (e.g. the stock count it comes from).", 400);
    movement.reason = "opening_balance";
  }
  if (body.action === "receipt") movement.reason = "receipt";
  if (body.action.startsWith("adjustment_")) {
    if (!Object.prototype.hasOwnProperty.call(ADJUSTMENT_REASONS, body.reason)) {
      throw new RequestError("invalid-request", `Reason must be one of: ${Object.keys(ADJUSTMENT_REASONS).join(", ")}`, 400);
    }
    if (body.reason === "other" && !note) throw new RequestError("invalid-request", "Explain the adjustment in the note.", 400);
    movement.reason = body.reason;
  }
  return movement;
}

export function createInventoryHandler({ getAdmin: loadAdmin }) {
  return withErrorHandling("inventory", async (event) => {
    requireMethod(event, "POST");
    // Authenticate and authorize BEFORE reporting anything about the body.
    let body = null;
    let bodyError = null;
    try {
      body = parseJsonBody(event, 4096);
    } catch (err) {
      bodyError = err;
    }
    const action = (body && ACTIONS[body.action]) || null;
    const { db, auth, admin } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, module: "inventory", permission: action ? action.permission : null, write: true });
    if (bodyError) throw bodyError;
    if (!action) throw new RequestError("invalid-request", "Unknown action.", 400);
    only(body, action.fields);
    const movement = movementFrom(body);

    const result = await mapInventoryErrors(() =>
      recordMovement({ db, tenant: ctx.tenant, FieldValue: admin.firestore.FieldValue, productId: body.productId, movement, actor: actorOf(ctx) })
    );
    const seesCosts = ctx.permissions["inventory.costs"] === true;
    return respond(200, {
      success: true,
      productId: result.productId,
      transactionId: result.transactionId,
      balance: { onHand: result.next.onHand, reserved: result.next.reserved, available: result.next.available, isLowStock: result.next.isLowStock },
      ...(seesCosts ? { cost: { avgCostUnits: result.next.avgCostUnits, avgUnitCostCentavos: result.next.avgCostUnits === null ? null : costUnitsToCentavos(result.next.avgCostUnits) } } : {}),
    });
  });
}

export const handler = createInventoryHandler({ getAdmin });
