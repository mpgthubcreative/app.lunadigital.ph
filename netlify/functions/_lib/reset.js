// Reset Workspace Data (2026-10-21), server side: what shared/reset.js
// lists for this workspace, and nothing else. Every path goes through
// tenantDb(db, businessId) (this business only); files only under
// tenants/{businessId}/. The audit records (this business's and Luna's)
// are written first, so a reset is never unrecorded.

import { RESET_CONFIRM_WORD, RESET_NESTED, resetPlanFor } from "../../../shared/reset.js";
import { tenantDb } from "./tenant-db.js";
import { removeMember } from "./provisioning.js";
import { computeRecount, applyRecount } from "./recount.js";

export class ResetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const PAGE = 300;

async function deleteCollection(db, col, nested = []) {
  let removed = 0;
  for (;;) {
    const snap = await col.limit(PAGE).get();
    if (snap.empty) return removed;
    for (const d of snap.docs) for (const sub of nested) removed += await deleteCollection(db, d.ref.collection(sub));
    const batch = db.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    removed += snap.docs.length;
    if (snap.docs.length < PAGE) return removed;
  }
}

export async function resetWorkspaceData({ db, admin, bucket, businessId, actor, confirm }) {
  if (confirm !== RESET_CONFIRM_WORD) throw new ResetError("confirm-mismatch", `Type ${RESET_CONFIRM_WORD} to confirm`);
  const tenant = tenantDb(db, businessId);
  const snap = await tenant.ref.get();
  if (!snap.exists) throw new ResetError("not-found", "Business not found");
  const business = snap.data();
  const plan = resetPlanFor(business.workspaceTemplateId);
  if (!plan) throw new ResetError("not-resettable", "This workspace can't be reset here. Contact Luna support.");
  const FieldValue = admin.firestore.FieldValue;
  const who = actor.email ?? actor.uid;

  const started = { type: "data.reset-started", summary: `Workspace data reset by the owner (${plan.label})`, businessId, actor: who, at: FieldValue.serverTimestamp() };
  await tenant.collection("auditLog").doc().set(started);

  // Kasambahay logins go with their staff records (the person's sign-in
  // account stays; only this membership is removed).
  const loginsRemoved = [];
  if (plan.removesStaffLogins) {
    const members = await tenant.collection("members").get();
    for (const m of members.docs) {
      if (typeof m.data().staffId !== "string" || m.data().isAccountOwner === true) continue;
      await removeMember({ db, admin, businessId, uid: m.id, audit: { actor: who, reason: "Workspace data reset" } });
      loginsRemoved.push(m.id);
    }
  }

  const counts = {};
  for (const name of plan.removes) {
    // Order payment links: the public pointer (top level) goes first.
    if (name === "orderPayLinks") for (const d of (await tenant.collection(name).get()).docs) if (d.data().hash) await db.collection("orderPayLinks").doc(d.data().hash).delete();
    const n = await deleteCollection(db, tenant.collection(name), RESET_NESTED[name] || []);
    if (n) counts[name] = n;
  }

  // Files: this business's prefix only.
  let files = 0;
  if (bucket) {
    const b = await bucket();
    const [list] = await b.getFiles({ prefix: `tenants/${businessId}/` });
    for (const f of list) {
      await b.file(f.name).delete().catch(() => {});
      files += 1;
    }
    // Storage used: recounted from what's left (nothing).
    try {
      const dry = await computeRecount({ db, bucket, businessId, counter: "storageBytes" });
      if (dry.action === "set") await applyRecount({ db, admin, bucket, businessId, counter: "storageBytes", actor: who, reason: "Workspace data reset", expectedCurrent: dry.current });
    } catch (err) {
      console.error(`reset: storage recount for ${businessId} failed: ${err.message}`);
    }
  }

  const total = Object.values(counts).reduce((t, n) => t + n, 0);
  const record = { type: "data.reset", summary: `Workspace data reset by the owner: ${total} records and ${files} files removed`, businessId, actor: who, counts, files, staffLoginsRemoved: loginsRemoved.length, at: FieldValue.serverTimestamp() };
  const batch = db.batch();
  batch.set(tenant.collection("auditLog").doc(), record);
  batch.set(db.collection("platformAudit").doc(), { ...record, businessName: business.name ?? businessId });
  batch.update(tenant.ref, { lastResetAt: FieldValue.serverTimestamp(), lastResetBy: who });
  await batch.commit();
  return { reset: true, records: total, files, counts, staffLoginsRemoved: loginsRemoved.length };
}
