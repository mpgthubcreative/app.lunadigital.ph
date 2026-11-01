// POST /api/products   (products.manage + Inventory module + write access)
//   { action: "create", product: { sku, name, category?, unit, sellingPrice, reorderLevel } }
//   { action: "update", productId, changes: { ...any of the above } }
//   { action: "setStatus", productId, status: "active" | "inactive" }
//   { action: "delete", productId }              (only never-used products)
//   { action: "setUnitCost", productId, unitCost }  Costs → COGS: the
//        product's current unit cost (centavos); also needs inventory.costs
//   { action: "quickAdd", product: { name, sellingPrice, category?, stock?, unitCost? } }
//        (2026-11-01) Quick Add Product (e.g. inside New Order): no stock →
//        Track inventory OFF; stock → ON with that starting stock; a unit
//        cost needs inventory.costs
//   { action: "setTracking", productId, track, stock?, unitCost? }
//        Track inventory ON (optionally with the stock on hand now) / OFF
// Quantities are scaled integers and money is integer centavos
// (shared/quantity.js). Balances can't be set here at all.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { createProduct, updateProduct, setProductStatus, deleteUnusedProduct, setProductUnitCost, quickAddProduct, setTrackInventory } from "./_lib/inventory.js";
import { actorOf, only, mapInventoryErrors } from "./_lib/inventory-http.js";

const SHAPES = {
  create: ["action", "product"],
  update: ["action", "productId", "changes"],
  setStatus: ["action", "productId", "status"],
  delete: ["action", "productId"],
  setUnitCost: ["action", "productId", "unitCost"],
  quickAdd: ["action", "product"],
  setTracking: ["action", "productId", "track", "stock", "unitCost"],
};

// Product fields everyone with inventory.view may see (never costs).
function publicProduct(id, p) {
  const { createdAt, updatedAt, ...rest } = p;
  return { id, ...rest };
}

export function createProductsHandler({ getAdmin: loadAdmin }) {
  return withErrorHandling("products", async (event) => {
    requireMethod(event, "POST");
    const { db, auth, admin } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, permission: "products.manage", write: true });
    const body = parseJsonBody(event, 4096);
    const shape = SHAPES[body && body.action];
    if (!shape) throw new RequestError("invalid-request", "Unknown action.", 400);
    only(body, shape);
    const canCost = ctx.permissions["inventory.costs"] === true;
    if (body.action === "setUnitCost" && !canCost) throw new RequestError("forbidden", "You can't change product costs.", 403);
    if (body.action === "setTracking" && body.unitCost !== undefined && body.unitCost !== null && !canCost) throw new RequestError("forbidden", "You can't set product costs.", 403);

    const common = { db, tenant: ctx.tenant, FieldValue: admin.firestore.FieldValue, actor: actorOf(ctx) };
    const result = await mapInventoryErrors(async () => {
      switch (body.action) {
        case "create":
          return createProduct({ ...common, input: body.product });
        case "update":
          return updateProduct({ ...common, productId: body.productId, changes: body.changes });
        case "setUnitCost":
          return setProductUnitCost({ ...common, productId: body.productId, unitCost: body.unitCost });
        case "setStatus":
          return setProductStatus({ ...common, productId: body.productId, status: body.status });
        case "quickAdd":
          return quickAddProduct({ ...common, input: body.product, canSetCost: canCost });
        case "setTracking":
          return setTrackInventory({ ...common, productId: body.productId, track: body.track, stock: body.stock ?? null, unitCost: body.unitCost ?? null });
        default:
          return deleteUnusedProduct({ ...common, productId: body.productId });
      }
    });
    return respond(body.action === "create" || body.action === "quickAdd" ? 201 : 200, {
      success: true,
      productId: result.productId,
      ...(result.product ? { product: publicProduct(result.productId, result.product) } : {}),
      ...(result.deleted ? { deleted: true } : {}),
      ...(body.action === "setTracking" ? { trackInventory: result.trackInventory, ...(result.unchanged ? { unchanged: true } : {}) } : {}),
      ...(body.action === "setUnitCost" ? { unitCost: result.unitCost, ...(result.unchanged ? { unchanged: true } : {}) } : {}),
    });
  });
}

export const handler = createProductsHandler({ getAdmin });
