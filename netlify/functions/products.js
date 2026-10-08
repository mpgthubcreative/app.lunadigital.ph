// POST /api/products   (products.manage + Inventory module + write access)
//   { action: "create", product: { sku, name, category?, unit, sellingPrice, reorderLevel } }
//   { action: "update", productId, changes: { ...any of the above } }
//   { action: "setStatus", productId, status: "active" | "inactive" }
//   { action: "delete", productId }              (only never-used products)
// Quantities are scaled integers and money is integer centavos
// (shared/quantity.js). Balances and costs can't be set here at all.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { createProduct, updateProduct, setProductStatus, deleteUnusedProduct } from "./_lib/inventory.js";
import { actorOf, only, mapInventoryErrors } from "./_lib/inventory-http.js";

const SHAPES = {
  create: ["action", "product"],
  update: ["action", "productId", "changes"],
  setStatus: ["action", "productId", "status"],
  delete: ["action", "productId"],
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

    const common = { db, tenant: ctx.tenant, FieldValue: admin.firestore.FieldValue, actor: actorOf(ctx) };
    const result = await mapInventoryErrors(async () => {
      switch (body.action) {
        case "create":
          return createProduct({ ...common, input: body.product });
        case "update":
          return updateProduct({ ...common, productId: body.productId, changes: body.changes });
        case "setStatus":
          return setProductStatus({ ...common, productId: body.productId, status: body.status });
        default:
          return deleteUnusedProduct({ ...common, productId: body.productId });
      }
    });
    return respond(body.action === "create" ? 201 : 200, {
      success: true,
      productId: result.productId,
      ...(result.product ? { product: publicProduct(result.productId, result.product) } : {}),
      ...(result.deleted ? { deleted: true } : {}),
    });
  });
}

export const handler = createProductsHandler({ getAdmin });
