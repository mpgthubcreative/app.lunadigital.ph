// File-storage accounting and enforcement (Phase 18). Object storage and
// Firestore can't commit together, so every stored file goes through a
// small ledger:
//
//   reserve   (transaction)  bytes + live reservations + this file <= the
//             effective storageBytes limit, or the upload is refused BEFORE
//             anything is stored. Creates storageObjects/{id} "reserved"
//             and adds the bytes to usageCurrent/storage.reservedBytes.
//   upload    the object is written (outside any transaction).
//   finalize  inside the SAME transaction as the business record that
//             references the file (e.g. the payment): "reserved" -> "stored",
//             reservedBytes -> bytes. Both commit or neither does.
//   release   upload failed, or the business transaction failed (and the
//             object was removed): "reserved" -> "released", reservedBytes
//             given back.
//   delete    a supported removal of a stored file: "stored" -> "deleted",
//             bytes subtracted.
//
// Exactly once: every step is a state transition read inside its
// transaction, so a retry (or two racing requests) can't count, release or
// subtract the same object twice, and the totals are clamped at 0.
// Concurrency: reserve reads and rewrites usageCurrent/storage, so two
// uploads near the limit serialize on it and can't both pass.
// Crashes: a reservation never finalized (function died after reserving)
// expires after RESERVATION_MS; the next reservation sweeps it ("expired")
// and gives its bytes back. If its object was actually stored, the recount
// tool (./recount.js) finds and records it.
//
// The byte count is the server's own measurement of the bytes it stores
// (the decoded buffer), never a number from the browser.
//
// Documents (businesses/{bid}/..., server-only):
//   usageCurrent/storage    { bytes, reservedBytes, objects, alerts, updatedAt, recountedAt? }
//   storageObjects/{id}     { path, bytes, area, state, recordType, recordId, reservedAt, expiresAt, finalizedAt, ... }
//                           id = sha256(path)[0..40]

import { createHash } from "node:crypto";
import { MeteringError, effectiveLimit } from "../../../shared/metering.js";
import { usageCurrentRef, nonNegative, prepareRunningAlerts } from "./metering.js";

export const RESERVATION_MS = 10 * 60 * 1000;
const SWEEP_BATCH = 20;
export const STORAGE_OBJECT_SCHEMA_VERSION = 1;

export const storageObjectId = (path) => createHash("sha256").update(path).digest("hex").slice(0, 40);
export const storageLedgerRef = (tenant, id) => tenant.doc("storageObjects", id);
const currentRef = (tenant) => usageCurrentRef(tenant, "storage");

export function storageState(snap) {
  const d = snap && snap.exists ? snap.data() : {};
  return { bytes: nonNegative(d.bytes), reservedBytes: nonNegative(d.reservedBytes), objects: nonNegative(d.objects), alerts: d.alerts && typeof d.alerts === "object" ? d.alerts : {} };
}
const millis = (v) => (v instanceof Date ? v.getTime() : typeof v?.toMillis === "function" ? v.toMillis() : typeof v === "number" ? v : 0);

function limitOf(bizSnap) {
  const limit = effectiveLimit(bizSnap.exists ? bizSnap.data().entitlements : null, "storageBytes");
  if (limit === null) throw new MeteringError("business-misconfigured", "This business has no valid storage limit");
  return limit;
}

export function storageFullError({ used, limit, bytes }) {
  const err = new MeteringError("storage-limit-reached", "Your plan's file storage is full, so this file wasn't saved. Contact Luna to raise the storage limit.");
  err.details = { meterId: "storageBytes", used, limit, bytes };
  return err;
}

// Reserve room for one object (its own transaction). Idempotent per path.
export async function reserveStorage({ db, tenant, FieldValue, path, bytes, area, recordType = null, recordId = null, now = new Date() }) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new MeteringError("invalid-size", "Invalid file size");
  if (typeof path !== "string" || !path.startsWith(`tenants/${tenant.businessId}/`)) throw new MeteringError("invalid-path", "Invalid storage path");
  const id = storageObjectId(path);
  const ref = storageLedgerRef(tenant, id);
  return db.runTransaction(async (tx) => {
    const [biz, cur, led, stale] = await Promise.all([
      tx.get(tenant.ref),
      tx.get(currentRef(tenant)),
      tx.get(ref),
      tx.get(tenant.collection("storageObjects").where("state", "==", "reserved").where("expiresAt", "<", now).limit(SWEEP_BATCH)),
    ]);
    if (led.exists) {
      const l = led.data();
      if (l.path === path && l.bytes === bytes && (l.state === "reserved" || l.state === "stored")) return { objectId: id, bytes, replayed: true };
      throw new MeteringError("storage-conflict", "This file was already handled");
    }
    const limit = limitOf(biz);
    const s = storageState(cur);
    const swept = stale.docs.filter((d) => d.id !== id);
    const reserved = Math.max(0, s.reservedBytes - swept.reduce((sum, d) => sum + nonNegative(d.data().bytes), 0));
    if (s.bytes + reserved + bytes > limit) throw storageFullError({ used: s.bytes, limit, bytes });
    const stamp = FieldValue.serverTimestamp();
    for (const d of swept) tx.update(d.ref, { state: "expired", expiredAt: stamp });
    tx.create(ref, { schemaVersion: STORAGE_OBJECT_SCHEMA_VERSION, path, bytes, area, state: "reserved", recordType, recordId, reservedAt: now, expiresAt: new Date(now.getTime() + RESERVATION_MS), finalizedAt: null, releasedAt: null, deletedAt: null });
    tx.set(currentRef(tenant), { bytes: s.bytes, reservedBytes: reserved + bytes, objects: s.objects, updatedAt: stamp }, { merge: true });
    return { objectId: id, bytes, used: s.bytes, limit };
  });
}

// Inside the business transaction (all reads here; writes in commit).
export async function prepareStorageFinalize(tx, { tenant, objectId }) {
  const ref = storageLedgerRef(tenant, objectId);
  const [led, cur, biz] = await Promise.all([tx.get(ref), tx.get(currentRef(tenant)), tx.get(tenant.ref)]);
  if (!led.exists) throw new MeteringError("storage-reservation-missing", "The upload wasn't reserved; try again");
  const l = led.data();
  if (l.state === "stored") return { objectId, bytes: l.bytes, alreadyStored: true, commit: () => {} };
  if (l.state !== "reserved" && l.state !== "expired") throw new MeteringError("storage-reservation-lost", "The upload took too long; try again");
  const limit = limitOf(biz);
  const s = storageState(cur);
  let reserved = s.reservedBytes;
  if (l.state === "reserved") reserved = Math.max(0, reserved - l.bytes);
  // An expired reservation already gave its bytes back: it must fit again.
  else if (s.bytes + reserved + l.bytes > limit) throw storageFullError({ used: s.bytes, limit, bytes: l.bytes });
  const bytes = s.bytes + l.bytes;
  const alerts = await prepareRunningAlerts(tx, { tenant, meterId: "storageBytes", state: s.alerts, used: bytes, limit });
  return {
    objectId,
    bytes: l.bytes,
    alreadyStored: false,
    commit({ FieldValue }) {
      const stamp = FieldValue.serverTimestamp();
      tx.update(ref, { state: "stored", finalizedAt: stamp });
      tx.set(currentRef(tenant), { bytes, reservedBytes: reserved, objects: s.objects + 1, alerts: alerts.next, updatedAt: stamp }, { merge: true });
      alerts.notes.commit({ FieldValue });
    },
  };
}

// Gives a reservation back (upload failed / business transaction failed).
// Never touches a stored object; a second call is a no-op.
export async function releaseStorageReservation({ db, tenant, FieldValue, objectId }) {
  const ref = storageLedgerRef(tenant, objectId);
  return db.runTransaction(async (tx) => {
    const [led, cur] = await Promise.all([tx.get(ref), tx.get(currentRef(tenant))]);
    if (!led.exists) return { released: false };
    const l = led.data();
    if (l.state !== "reserved" && l.state !== "expired") return { released: false, state: l.state };
    const stamp = FieldValue.serverTimestamp();
    tx.update(ref, { state: "released", releasedAt: stamp });
    // "expired" already gave its bytes back when it was swept.
    if (l.state === "reserved") {
      const s = storageState(cur);
      tx.set(currentRef(tenant), { reservedBytes: Math.max(0, s.reservedBytes - l.bytes), updatedAt: stamp }, { merge: true });
    }
    return { released: true };
  });
}

// A supported removal of a stored file, inside the caller's transaction.
export async function prepareStorageDelete(tx, { tenant, objectId }) {
  const ref = storageLedgerRef(tenant, objectId);
  const [led, cur, biz] = await Promise.all([tx.get(ref), tx.get(currentRef(tenant)), tx.get(tenant.ref)]);
  if (!led.exists || led.data().state !== "stored") return { deleted: false, path: led.exists ? led.data().path : null, commit: () => {} };
  const l = led.data();
  const s = storageState(cur);
  const bytes = Math.max(0, s.bytes - nonNegative(l.bytes));
  const limit = effectiveLimit(biz.exists ? biz.data().entitlements : null, "storageBytes");
  // Going down can re-arm a warning (no notification is sent on the way down).
  const alerts = await prepareRunningAlerts(tx, { tenant, meterId: "storageBytes", state: s.alerts, used: bytes, limit });
  return {
    deleted: true,
    path: l.path,
    bytes: l.bytes,
    commit({ FieldValue }) {
      const stamp = FieldValue.serverTimestamp();
      tx.update(ref, { state: "deleted", deletedAt: stamp });
      tx.set(currentRef(tenant), { bytes, objects: Math.max(0, s.objects - 1), alerts: alerts.next, updatedAt: stamp }, { merge: true });
      alerts.notes.commit({ FieldValue });
    },
  };
}

// Deletes a stored file: the accounting first (exactly once), then the
// object. If the object delete fails, it stays as an orphan that the
// recount tool reports and re-records.
export async function deleteStoredFile({ db, tenant, FieldValue, bucket, objectId }) {
  const r = await db.runTransaction(async (tx) => {
    const plan = await prepareStorageDelete(tx, { tenant, objectId });
    plan.commit({ FieldValue });
    return { deleted: plan.deleted, path: plan.path, bytes: plan.bytes ?? 0 };
  });
  if (r.deleted && r.path) {
    try {
      await (await bucket()).file(r.path).delete();
    } catch (err) {
      console.error("deleteStoredFile: object delete failed (recount will report it):", err?.message);
    }
  }
  return r;
}

export { millis };
