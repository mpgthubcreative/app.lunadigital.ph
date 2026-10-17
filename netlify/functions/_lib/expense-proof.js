// Owner-pilot Bridal: a proof (receipt photo / screenshot or PDF) on one
// wedding expense. Every amount paid in Bridal is an expense (a supplier
// payment is an expense paid to that supplier), so the proof belongs to the
// expense record. Same pipeline as payroll / payment proofs: decoded and
// type-checked here, storage reserved (plan limit), uploaded with the Admin
// SDK, finalized in the record's transaction. The object is never reachable
// by URL (Storage rules deny every browser read outside the listed areas);
// it's served only through POST /api/expenses { action: "proof" } to
// members with expenses.view in the SAME business.
//
// Replace: the new file is stored and linked first, then the old one is
// deleted (its storage given back). The history keeps both events.

import { randomBytes } from "node:crypto";
import { ExpenseError } from "../../../shared/expenses.js";
import { decodePayrollProof } from "./payroll.js";
import { reserveStorage, prepareStorageFinalize, releaseStorageReservation, deleteStoredFile } from "./storage-usage.js";

const TX_OPTIONS = { maxAttempts: 10 };
const MAX_HISTORY_ENTRIES = 200;
const EXPENSE_ID = /^[A-Za-z0-9]{8,40}$/;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/pdf": "pdf" };
export const EXPENSE_PROOF_PREFIX = (businessId) => `tenants/${businessId}/expenses/proofs/`;

function expenseRef(tenant, id) {
  if (typeof id !== "string" || !EXPENSE_ID.test(id)) throw new ExpenseError("invalid-expense", "Invalid expense");
  return tenant.doc("expenses", id);
}
// Wedding expenses only (other workspaces don't offer proofs on expenses).
function requireWedding(workspace) {
  if (workspace !== "bridal-expense") throw new ExpenseError("not-available", "Proofs aren't available for these expenses.");
}
function decode(proof) {
  try {
    return decodePayrollProof(proof);
  } catch (err) {
    throw new ExpenseError(err?.code === "proof-too-large" ? "proof-too-large" : "invalid-proof", err?.message?.replace(/Screenshots?/g, "Proofs") || "Invalid proof");
  }
}
const who = (actor) => (actor ? { uid: actor.uid, name: actor.name } : null);

export async function attachExpenseProof({ db, bucket, tenant, FieldValue, workspace, expenseId, proof, actor, now = new Date() }) {
  requireWedding(workspace);
  if (!bucket) throw new ExpenseError("not-available", "Proof uploads aren't available");
  const ref = expenseRef(tenant, expenseId);
  const first = await ref.get();
  if (!first.exists) throw new ExpenseError("not-found", "Expense not found");
  if (first.data().status !== "active") throw new ExpenseError("removed", "This expense was removed");
  const decoded = decode(proof);
  const path = `${EXPENSE_PROOF_PREFIX(tenant.businessId)}${expenseId}-${randomBytes(4).toString("hex")}.${EXT[decoded.contentType]}`;
  const reservation = await reserveStorage({ db, tenant, FieldValue, path, bytes: decoded.data.length, area: "expenses", recordType: "expense", recordId: expenseId, now });
  const undo = async () => {
    try {
      await (await bucket()).file(path).delete();
    } catch {
      /* the object may not exist */
    }
    await releaseStorageReservation({ db, tenant, FieldValue, objectId: reservation.objectId }).catch(() => {});
  };
  try {
    await (await bucket()).file(path).save(decoded.data, { resumable: false, contentType: decoded.contentType, metadata: { metadata: { uploadedBy: actor.uid, expenseId } } });
  } catch (err) {
    await undo();
    throw err;
  }
  const stored = { path, contentType: decoded.contentType, size: decoded.data.length, objectId: reservation.objectId, uploadedBy: who(actor), uploadedAt: now };
  let previous = null;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ExpenseError("not-found", "Expense not found");
      const e = snap.data();
      if (e.status !== "active") throw new ExpenseError("removed", "This expense was removed");
      const file = await prepareStorageFinalize(tx, { tenant, objectId: stored.objectId });
      previous = e.proof && e.proof.objectId !== stored.objectId ? e.proof : null;
      const history = Array.isArray(e.history) ? e.history : [];
      if (history.length >= MAX_HISTORY_ENTRIES) throw new ExpenseError("history-full", "Too many changes on this record");
      const kind = decoded.contentType === "application/pdf" ? "PDF" : "photo";
      tx.update(ref, { proof: stored, history: [...history, { type: previous ? "proof-replaced" : "proof-added", at: now, actor: who(actor), label: previous ? `Proof replaced (${kind})` : `Proof added (${kind})` }], updatedAt: FieldValue.serverTimestamp() });
      file.commit({ FieldValue });
    }, TX_OPTIONS);
  } catch (err) {
    await undo();
    throw err;
  }
  // The replaced file: accounting first, then the object.
  if (previous?.objectId) await deleteStoredFile({ db, tenant, FieldValue, bucket, objectId: previous.objectId }).catch((err) => console.error("expense proof: old file not deleted:", err?.message));
  return { expenseId, hasProof: true, replaced: Boolean(previous), proof: { contentType: stored.contentType, size: stored.size } };
}

// The proof's bytes, for a member of the SAME business with expenses.view.
export async function readExpenseProof({ tenant, bucket, workspace, expenseId }) {
  requireWedding(workspace);
  const snap = await expenseRef(tenant, expenseId).get();
  const proof = snap.exists ? snap.data().proof : null;
  if (!proof) throw new ExpenseError("not-found", "No proof on this expense");
  if (typeof proof.path !== "string" || !proof.path.startsWith(EXPENSE_PROOF_PREFIX(tenant.businessId))) throw new ExpenseError("not-found", "No proof on this expense");
  const [data] = await (await bucket()).file(proof.path).download();
  return { contentType: proof.contentType, dataBase64: data.toString("base64") };
}
