// POST /api/workbook   { range?: "month" | "custom" | "all", from?, to? }
//   -> the workspace's ONE clean Excel workbook (More → Download Excel).
//
// The customer-facing download (shared/workbook.js, ./_lib/workbook/). A
// member who may export (data.export) of THIS business only: the tenant is
// resolved by requireTenant (membership, subscription), never named by the
// request. Each sheet also needs its module + view permission. Reads only:
// works while suspended (like the screens). Not the Master Backup, which is
// Luna Super Admin only (/api/backup). Errors are JSON; success is the file.

import { withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { buildWorkbook } from "./_lib/workbook/index.js";
import { WORKBOOK_PERMISSION, WorkbookError } from "../../shared/workbook.js";

const FIELDS = ["range", "from", "to"];
const STATUS = { "not-allowed": 403, "invalid-range": 400, "too-many-rows": 413 };
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function createWorkbookHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("workbook", async (event) => {
    requireMethod(event, "POST");
    let body = null;
    let bodyError = null;
    try {
      body = parseJsonBody(event, 1000);
    } catch (err) {
      bodyError = err;
    }
    const { db, auth, admin } = await loadAdmin();
    // Authenticate first so an anonymous caller learns nothing from validation.
    const ctx = await requireTenant(event, { db, auth, permission: WORKBOOK_PERMISSION });
    if (bodyError) throw bodyError;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("invalid-request", "Invalid request.", 400);
    for (const k of Object.keys(body)) if (!FIELDS.includes(k)) throw new RequestError("invalid-request", `Unknown field ${k}.`, 400);
    try {
      const out = await buildWorkbook({ db, ctx, admin, input: body, now: now() });
      return {
        statusCode: 200,
        headers: { "Content-Type": XLSX, "Content-Disposition": `attachment; filename="${out.fileName}"`, "Cache-Control": "no-store", "X-Luna-Export-Rows": String(out.rowCount) },
        body: Buffer.from(out.bytes).toString("base64"),
        isBase64Encoded: true,
      };
    } catch (err) {
      if (err instanceof WorkbookError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createWorkbookHandler({ getAdmin });
