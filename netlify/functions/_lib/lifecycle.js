// Super Admin: deleting a business is RECOVERABLE (2026-10-19).
//
//   Delete   typed confirmation of the exact business name; the business is
//            marked deleted (subscription.status "deleted"): every sign-in
//            and API call is refused at once (shared/subscription.js
//            accessPolicy and firestore.rules only admit known live
//            statuses), and nothing is erased. A purge date is recorded
//            (RETENTION_DAYS later); permanent purge is a later, separate
//            tool.
//   Restore  within the retention period: the status it had before.
// Both audited (platform + business log): business id and name, prior plan
// and status, who, when.

import { businessDate } from "../../../shared/metrics.js";
import { shiftDay } from "../../../shared/plan-billing.js";
import { tenantDb } from "./tenant-db.js";
import { ProvisioningError } from "./provisioning.js";

export const RETENTION_DAYS = 30;
const TX = { maxAttempts: 10 };

export async function deleteBusiness({ db, FieldValue, businessId, confirmName, reason = null, operator, now = new Date() }) {
  const ref = db.collection("businesses").doc(businessId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ProvisioningError("not-found", "Business not found.");
    const b = snap.data();
    if (b.subscription?.status === "deleted") return { businessId, deleted: true, alreadyDeleted: true, purgeAfter: b.deletion?.purgeAfter ?? null };
    if (typeof confirmName !== "string" || confirmName.trim() !== String(b.name || "").trim()) throw new ProvisioningError("confirm-mismatch", `Type the business name exactly: ${b.name}`);
    const today = businessDate("Asia/Manila", now);
    const prior = { status: b.subscription?.status ?? null, planId: b.subscription?.planId ?? null };
    const deletion = { deletedAt: FieldValue.serverTimestamp(), deletedBy: operator, purgeAfter: shiftDay(today, RETENTION_DAYS), prior, reason: typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 300) : null };
    tx.update(ref, { "subscription.status": "deleted", deletion, adminRevision: (Number.isSafeInteger(b.adminRevision) ? b.adminRevision : 0) + 1, updatedAt: FieldValue.serverTimestamp() });
    const record = { type: "business.deleted", summary: `Business deleted (recoverable until ${deletion.purgeAfter}): ${b.name}`, businessId, businessName: b.name ?? null, actor: operator, reason: deletion.reason, before: prior, after: { status: "deleted", purgeAfter: deletion.purgeAfter }, at: FieldValue.serverTimestamp() };
    tx.set(db.collection("platformAudit").doc(), record);
    tx.set(tenantDb(db, businessId).collection("auditLog").doc(), record);
    return { businessId, deleted: true, purgeAfter: deletion.purgeAfter };
  }, TX);
}

export async function restoreBusiness({ db, FieldValue, businessId, operator }) {
  const ref = db.collection("businesses").doc(businessId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ProvisioningError("not-found", "Business not found.");
    const b = snap.data();
    if (b.subscription?.status !== "deleted") return { businessId, restored: false, notDeleted: true };
    const status = b.deletion?.prior?.status && b.deletion.prior.status !== "deleted" ? b.deletion.prior.status : "suspended";
    tx.update(ref, { "subscription.status": status, deletion: null, adminRevision: (Number.isSafeInteger(b.adminRevision) ? b.adminRevision : 0) + 1, updatedAt: FieldValue.serverTimestamp() });
    const record = { type: "business.restored", summary: `Business restored: ${b.name}`, businessId, businessName: b.name ?? null, actor: operator, before: { status: "deleted" }, after: { status }, at: FieldValue.serverTimestamp() };
    tx.set(db.collection("platformAudit").doc(), record);
    tx.set(tenantDb(db, businessId).collection("auditLog").doc(), record);
    return { businessId, restored: true, status };
  }, TX);
}
