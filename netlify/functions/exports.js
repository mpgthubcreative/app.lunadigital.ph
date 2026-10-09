// POST /api/exports   { dataset, filters }  -> the .xlsx file (Phase 12.5)
//
// One endpoint for every Excel download. The browser sends only a dataset
// id from EXPORT_DATASETS and the screen's filters; it can't name a
// collection, field, sort key or business. Access is the dataset's module +
// export permission (requireTenant: membership, subscription, entitlement,
// workspace), then the view permissions and filters in runExport(). Reads
// only: works while suspended (like the screens). Errors are JSON; success
// is the binary workbook.

import { withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { runExport } from "./_lib/export-core.js";
import { RECORD_BUILDERS } from "./_lib/exports/records.js";
import { SUMMARY_BUILDERS } from "./_lib/exports/summaries.js";
import { PAYROLL_BUILDERS } from "./_lib/exports/payroll.js";
import { EXPORT_DATASETS } from "../../shared/export-datasets.js";
import { ExportError } from "../../shared/exports.js";

const BUILDERS = { ...RECORD_BUILDERS, ...SUMMARY_BUILDERS, ...PAYROLL_BUILDERS };
const FIELDS = ["dataset", "filters"];
const STATUS = { "too-many-rows": 413, "not-allowed": 403, "invalid-filters": 400, "invalid-range": 400 };
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function createExportsHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("exports", async (event) => {
    requireMethod(event, "POST");
    let body = null;
    let bodyError = null;
    try {
      body = parseJsonBody(event, 4000);
    } catch (err) {
      bodyError = err;
    }
    const { db, auth, admin } = await loadAdmin();
    // Authenticate first so an anonymous caller learns nothing from validation.
    const descriptor = body && typeof body.dataset === "string" && Object.prototype.hasOwnProperty.call(EXPORT_DATASETS, body.dataset) ? EXPORT_DATASETS[body.dataset] : null;
    const ctx = await requireTenant(event, { db, auth, permission: descriptor ? descriptor.exportPermission : null, module: descriptor ? descriptor.module : null });
    if (bodyError) throw bodyError;
    if (!descriptor) throw new RequestError("invalid-request", "Unknown export.", 400);
    for (const k of Object.keys(body)) if (!FIELDS.includes(k)) throw new RequestError("invalid-request", `Unknown field ${k}.`, 400);

    try {
      const out = await runExport({ db, ctx, admin, descriptor, builder: BUILDERS[descriptor.id], rawFilters: body.filters, now: now() });
      return {
        statusCode: 200,
        headers: {
          "Content-Type": XLSX,
          "Content-Disposition": `attachment; filename="${out.fileName}"`,
          "Cache-Control": "no-store",
          "X-Luna-Export-Rows": String(out.rowCount),
        },
        body: Buffer.from(out.bytes).toString("base64"),
        isBase64Encoded: true,
      };
    } catch (err) {
      if (err instanceof ExportError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createExportsHandler({ getAdmin });
