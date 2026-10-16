// POST /api/backup   -> the Master Backup .xlsx (Owner-pilot: More → Export & Backup)
// One workbook with every record of the business (./_lib/backup.js). The
// Owner only (billing.view) who may also export (data.export): it holds
// everything, Users included. Reads only. Kept apart from the everyday
// screens so it can become a paid unlock later (one place to gate).

import { withErrorHandling, requireMethod, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { buildBackup, BackupError } from "./_lib/backup.js";
import { EXPORT_PERMISSION } from "../../shared/exports.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const BACKUP_PERMISSIONS = ["billing.view", EXPORT_PERMISSION];

export function createBackupHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("backup", async (event) => {
    requireMethod(event, "POST");
    const { db, auth, admin } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, permission: "billing.view" });
    if (ctx.permissions[EXPORT_PERMISSION] !== true) throw new RequestError("not-allowed", "You can't download the backup.", 403);
    try {
      const out = await buildBackup({ db, tenant: ctx.tenant, business: ctx.business, entitlements: ctx.entitlements, FieldPath: admin.firestore.FieldPath, actor: { uid: ctx.uid, name: ctx.user?.name || "", email: ctx.user?.email || "" }, now: now() });
      return {
        statusCode: 200,
        headers: { "Content-Type": XLSX, "Content-Disposition": `attachment; filename="${out.fileName}"`, "Cache-Control": "no-store", "X-Luna-Export-Rows": String(out.rows) },
        body: Buffer.from(out.bytes).toString("base64"),
        isBase64Encoded: true,
      };
    } catch (err) {
      if (err instanceof BackupError) throw new RequestError(err.code, err.message, 413);
      throw err;
    }
  });
}

export const handler = createBackupHandler({ getAdmin });
