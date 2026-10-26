// POST /api/storefront   (Orders module) the business's public menu link.
//   { action: "get" }                  orders.view: the link and settings
//                                      (a link name is made on first use)
//   { action: "save", settings: { open?, displayName?, slug?, note?, pickup?,
//       delivery?, paymentMethods?, hiddenProductIds? } }   settings.manage
//   { action: "menu" }                 inventory.view: which products are off the menu
//   { action: "showOnMenu", productId, show }   products.manage: Show on Menu ON / OFF
// Changing the link name frees the old one (it stops working at once).
// The public page itself is /api/store (no login).

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { actorOf, only } from "./_lib/inventory-http.js";
import { readStoreSettings, saveStoreSettings, readMenu, setShowOnMenu } from "./_lib/storefront.js";
import { StorefrontError } from "../../shared/storefront.js";

const ACTIONS = {
  get: { permission: "orders.view", fields: ["action"], write: true },
  save: { permission: "settings.manage", fields: ["action", "settings"], write: true },
  // Show on Menu (Inventory's inline ON / OFF): read, and one product at a time.
  menu: { permission: "inventory.view", fields: ["action"], write: false },
  showOnMenu: { permission: "products.manage", fields: ["action", "productId", "show"], write: true },
};
const STATUS = { "slug-taken": 409, "invalid-input": 400, "not-found": 404 };

export function createStorefrontHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("storefront", async (event) => {
    requireMethod(event, "POST");
    let body = null;
    let bodyError = null;
    try {
      body = parseJsonBody(event, 16384);
    } catch (err) {
      bodyError = err;
    }
    const action = (body && ACTIONS[body.action]) || null;
    const { db, auth, admin } = await loadAdmin();
    // Authenticate and authorize BEFORE reporting anything about the body.
    const ctx = await requireTenant(event, { db, auth, module: "orders", permission: action ? action.permission : "orders.view", write: action ? action.write : false });
    if (bodyError) throw bodyError;
    if (!action) throw new RequestError("invalid-request", "Unknown action.", 400);
    only(body, action.fields);
    try {
      const FieldValue = admin.firestore.FieldValue;
      if (body.action === "menu") return respond(200, { success: true, ...(await readMenu({ tenant: ctx.tenant, business: ctx.business })) });
      if (body.action === "showOnMenu") return respond(200, { success: true, ...(await setShowOnMenu({ db, tenant: ctx.tenant, FieldValue, business: ctx.business, productId: body.productId, show: body.show, actor: actorOf(ctx) })) });
      const result =
        body.action === "get"
          ? await readStoreSettings({ db, tenant: ctx.tenant, business: ctx.business, now: now() })
          : await saveStoreSettings({ db, tenant: ctx.tenant, FieldValue: admin.firestore.FieldValue, business: ctx.business, input: body.settings, actor: actorOf(ctx), now: now() });
      return respond(200, { success: true, ...result, canManage: ctx.permissions["settings.manage"] === true });
    } catch (err) {
      if (err instanceof StorefrontError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createStorefrontHandler({ getAdmin });
