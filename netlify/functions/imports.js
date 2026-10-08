// POST /api/imports   (Imports module + imports.run; writes need subscription write access)
//   { action: "preview", type: "products" | "customers", fileName, rows: [{ n, values }], mapping? }
//   { action: "commit", jobId, includeWarnings? }    call again until { done: true }
//   { action: "cancel", jobId }
// Importing Products also needs the Inventory module + products.manage;
// Customers needs the Customers module + customers.manage. The browser
// only parses the file; every value is validated here, and commit imports
// the stored preview, never re-sent rows. Import History is read straight
// from Firestore under the rules (imports.run).

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { previewImport, commitImport, cancelImport } from "./_lib/imports.js";
import { actorOf, only } from "./_lib/inventory-http.js";
import { ImportError, IMPORT_TYPES } from "../../shared/imports.js";
import { canUseModule } from "../../shared/modules.js";

const ACTIONS = {
  preview: ["action", "type", "fileName", "rows", "mapping"],
  commit: ["action", "jobId", "includeWarnings"],
  cancel: ["action", "jobId"],
};

const STATUS = {
  "not-found": 404,
  "invalid-job": 400,
  "not-allowed": 403,
  "import-limit-reached": 403,
  expired: 409,
  cancelled: 409,
  "not-cancellable": 409,
  "too-many-rows": 413,
  "business-misconfigured": 503,
};

// 2,000 rows of short text fit comfortably.
const MAX_BODY = 3_000_000;

export function createImportsHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("imports", async (event) => {
    requireMethod(event, "POST");
    let body = null;
    let bodyError = null;
    try {
      body = parseJsonBody(event, MAX_BODY);
    } catch (err) {
      bodyError = err;
    }
    const { db, auth, admin } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, permission: "imports.run", write: true });
    if (bodyError) throw bodyError;
    const fields = body && ACTIONS[body.action];
    if (!fields) throw new RequestError("invalid-request", "Unknown action.", 400);
    only(body, fields);

    // The target data's own module + manage permission.
    const canImport = (type) => {
      const def = IMPORT_TYPES[type];
      return Boolean(def) && canUseModule({ entitlements: ctx.entitlements, permissions: ctx.permissions }, def.module) && ctx.permissions[def.permission] === true;
    };
    const common = { db, tenant: ctx.tenant, FieldValue: admin.firestore.FieldValue, actor: actorOf(ctx) };
    try {
      switch (body.action) {
        case "preview":
          if (!IMPORT_TYPES[body.type]) throw new ImportError("invalid-type", "Choose Products or Customers");
          if (!canImport(body.type)) throw new ImportError("not-allowed", "You can't import this kind of data");
          return respond(201, { success: true, ...(await previewImport({ ...common, type: body.type, fileName: body.fileName, rows: body.rows, mapping: body.mapping ?? null, now: now() })) });
        case "commit":
          if (body.includeWarnings !== undefined && typeof body.includeWarnings !== "boolean") throw new RequestError("invalid-request", "includeWarnings must be true or false.", 400);
          return respond(200, { success: true, ...(await commitImport({ ...common, business: ctx.business, entitlements: ctx.entitlements, jobId: body.jobId, includeWarnings: body.includeWarnings === true, now: now(), canImport })) });
        default:
          return respond(200, { success: true, ...(await cancelImport({ ...common, jobId: body.jobId, canImport })) });
      }
    } catch (err) {
      if (err instanceof ImportError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createImportsHandler({ getAdmin });
