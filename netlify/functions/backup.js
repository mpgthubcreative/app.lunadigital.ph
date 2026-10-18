// POST /api/backup   { businessId }  -> the Master Backup .xlsx
//
// LUNA SUPER ADMIN ONLY (Owner pilot, 2026-10-18). The technical copy of
// every record of one business (./_lib/backup.js): disaster recovery,
// migration, project transfer, support and audit. Not a customer download:
// customers get the clean workbook (/api/workbook, More → Download Excel).
//
// Enforced here, whatever the browser shows: a verified ID token AND an
// active Luna operator record (requireOperator). A business Owner / Admin /
// Staff gets 403 even for their own business; the business is named by the
// operator (it isn't the caller's tenant). Reads only; each download leaves
// a record in the business's audit log and in platformAudit.

import { withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireOperator } from "./_lib/operator.js";
import { tenantDb } from "./_lib/tenant-db.js";
import { buildBackup, BackupError } from "./_lib/backup.js";
import { isValidBusinessId } from "../../shared/tenancy.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function createBackupHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("backup", async (event) => {
    requireMethod(event, "POST");
    let body = null;
    let bodyError = null;
    try {
      body = parseJsonBody(event, 1000);
    } catch (err) {
      bodyError = err;
    }
    const { db, auth, admin } = await loadAdmin();
    // Operators only, before anything else is looked at.
    const op = await requireOperator(event, { db, auth });
    if (bodyError) throw bodyError;
    const businessId = body && typeof body === "object" ? body.businessId : null;
    if (!isValidBusinessId(businessId) || Object.keys(body).some((k) => k !== "businessId")) throw new RequestError("invalid-request", "Choose a business.", 400);
    const tenant = tenantDb(db, businessId);
    const snap = await tenant.ref.get();
    if (!snap.exists) throw new RequestError("not-found", "Business not found.", 404);
    const b = snap.data();
    const business = { id: businessId, name: b.name || "", timezone: b.timezone || "Asia/Manila", subscription: b.subscription || null };
    const at = now();
    try {
      const out = await buildBackup({ db, tenant, business, entitlements: b.entitlements, FieldPath: admin.firestore.FieldPath, actor: { uid: op.uid, name: op.name || "", email: op.email || "" }, now: at });
      const FieldValue = admin.firestore.FieldValue;
      const record = { type: "backup.downloaded", summary: "Master Backup downloaded (Luna Super Admin)", businessId, actor: op.email || op.uid, operator: { uid: op.uid, email: op.email || null }, rows: out.rows, at: FieldValue.serverTimestamp() };
      const batch = db.batch();
      batch.set(tenant.collection("auditLog").doc(), record);
      batch.set(db.collection("platformAudit").doc(), record);
      await batch.commit();
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
