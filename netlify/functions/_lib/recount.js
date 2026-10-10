// Usage recount / repair (Phase 18), used by scripts/recount-usage.js.
//
//   calculate -> show current vs expected (dry run) -> explicit apply -> audit
//
// Always targeted: ONE business, ONE counter, ONE month (monthly counters).
// Expected values come only from source records, never from another
// counter:
//   ordersCreated     orders whose order date is in the month, plus orders
//                     deleted later (their "order.deleted" audit snapshots)
//   excelImports      import jobs that started committing in the month
//   exportsGenerated  "export.generated" audit entries in the month
//   rowsExported      the rowCount of those same entries
//   storageBytes      the objects actually in the bucket under
//                     tenants/{bid}/ (in-flight reservations excluded),
//                     reconciled into the storageObjects ledger
//
// Enforced monthly counters (orders, imports) are NEVER lowered: they
// record quota already consumed. A recount that finds fewer source records
// than the counter only reports it. They can be raised (missed counts).
// Meter-only counters and storage (a current total) are set to the source.
//
// Apply re-checks that the counter still holds the value the dry run saw
// (otherwise "changed-meanwhile": run it again), and writes one
// "usage.recounted" audit record (tenant audit log + platform audit).

import { METERS, isPeriod, MeteringError } from "../../../shared/metering.js";
import { tenantDb } from "./tenant-db.js";
import { monthKey } from "./usage.js";
import { usageMonthRef, usageCurrentRef, nonNegative } from "./metering.js";
import { storageObjectId, storageLedgerRef, millis } from "./storage-usage.js";

export const RECOUNTABLE = Object.freeze({
  ordersCreated: { neverLower: true, source: "orders by order date + deleted-order audit snapshots" },
  excelImports: { neverLower: true, source: "import jobs that started committing" },
  exportsGenerated: { neverLower: false, source: "export.generated audit entries" },
  rowsExported: { neverLower: false, source: "rowCount of export.generated audit entries" },
  storageBytes: { neverLower: false, source: "objects in the storage bucket under tenants/{businessId}/" },
});

const toDate = (v) => (v instanceof Date ? v : typeof v?.toDate === "function" ? v.toDate() : null);

async function businessOf(db, businessId) {
  const tenant = tenantDb(db, businessId);
  const snap = await tenant.ref.get();
  if (!snap.exists) throw new MeteringError("not-found", `Business ${businessId} not found`);
  return { tenant, business: snap.data() };
}

async function expectedMonthly(tenant, counter, period, timezone) {
  if (counter === "ordersCreated") {
    const [orders, deleted] = await Promise.all([
      tenant.collection("orders").where("orderDate", ">=", `${period}-01`).where("orderDate", "<=", `${period}-31`).count().get(),
      tenant.collection("auditLog").where("type", "==", "order.deleted").get(),
    ]);
    const del = deleted.docs.filter((d) => String(d.data().snapshot?.orderDate ?? "").startsWith(period)).length;
    return { value: orders.data().count + del, details: { orders: orders.data().count, deletedOrders: del } };
  }
  if (counter === "excelImports") {
    const jobs = await tenant.collection("imports").where("status", "in", ["committing", "completed"]).get();
    const inMonth = jobs.docs.filter((d) => {
      const at = toDate(d.data().committedAt);
      return at && monthKey(timezone, at) === period;
    });
    return { value: inMonth.length, details: { committedJobs: inMonth.length } };
  }
  const entries = await tenant.collection("auditLog").where("type", "==", "export.generated").get();
  const inMonth = entries.docs.map((d) => d.data()).filter((a) => {
    const at = toDate(a.at);
    return at && monthKey(timezone, at) === period;
  });
  if (counter === "exportsGenerated") return { value: inMonth.length, details: { exports: inMonth.length } };
  return { value: inMonth.reduce((s, a) => s + nonNegative(a.rowCount), 0), details: { exports: inMonth.length } };
}

// The storage source: what's really in the bucket, against the ledger.
async function expectedStorage({ tenant, bucket, businessId, now }) {
  const listedAt = Date.now();
  const [files] = await (await bucket()).getFiles({ prefix: `tenants/${businessId}/` });
  const ledger = await tenant.collection("storageObjects").get();
  const byId = new Map(ledger.docs.map((d) => [d.id, d.data()]));
  const live = (l) => l && l.state === "reserved" && millis(l.expiresAt) > now.getTime();
  const objects = [];
  for (const f of files) {
    const size = Number(f.metadata?.size);
    if (!Number.isSafeInteger(size) || size < 0) continue;
    const id = storageObjectId(f.name);
    const l = byId.get(id);
    if (live(l)) continue; // an upload in progress: counted in reservedBytes, not here
    objects.push({ id, path: f.name, bytes: size, ledgerState: l?.state ?? null });
  }
  const present = new Set(objects.map((o) => o.id));
  const listedAll = new Set(files.map((f) => storageObjectId(f.name)));
  // Recorded but not listed. Only entries finalized well before the listing
  // started (a file stored during the listing may simply not be in it).
  const missing = ledger.docs.filter((d) => d.data().state === "stored" && !listedAll.has(d.id) && millis(d.data().finalizedAt) < listedAt - 60_000).map((d) => ({ id: d.id, path: d.data().path, bytes: nonNegative(d.data().bytes) }));
  return {
    value: objects.reduce((s, o) => s + o.bytes, 0),
    objects,
    missing,
    details: { objectsInBucket: objects.length, unrecorded: objects.filter((o) => o.ledgerState !== "stored").length, recordedButMissing: missing.length, inFlight: files.length - objects.length, present: present.size },
  };
}

// Dry run. Nothing is written.
export async function computeRecount({ db, bucket, businessId, counter, period = null, now = new Date() }) {
  if (!Object.hasOwn(RECOUNTABLE, counter)) throw new MeteringError("not-recountable", `${counter} can't be recounted (no reliable source records). Recountable: ${Object.keys(RECOUNTABLE).join(", ")}`);
  const { tenant, business } = await businessOf(db, businessId);
  const timezone = business.timezone || "UTC";
  if (METERS[counter].kind === "monthly") {
    if (!isPeriod(period)) throw new MeteringError("invalid-period", "Give the month as YYYY-MM");
    const snap = await usageMonthRef(tenant, period).get();
    const current = snap.exists ? nonNegative(snap.data()[counter]) : 0;
    const exp = await expectedMonthly(tenant, counter, period, timezone);
    const lower = exp.value < current && RECOUNTABLE[counter].neverLower;
    const bucketTz = snap.exists ? snap.data().timezone ?? null : null;
    return {
      businessId,
      counter,
      period,
      timezone,
      bucketTimezone: bucketTz,
      current,
      expected: exp.value,
      difference: exp.value - current,
      action: exp.value === current ? "none" : lower ? "report-only" : "set",
      note: lower ? "The counter is higher than the source records. Quota already consumed is never given back, so it won't be lowered." : bucketTz && bucketTz !== timezone ? `This month was counted in ${bucketTz}; the business is now in ${timezone}. Recounting uses ${timezone}.` : null,
      source: RECOUNTABLE[counter].source,
      details: exp.details,
    };
  }
  const cur = await usageCurrentRef(tenant, "storage").get();
  const current = cur.exists ? nonNegative(cur.data().bytes) : 0;
  const exp = await expectedStorage({ tenant, bucket, businessId, now });
  const ledgerOff = exp.objects.some((o) => o.ledgerState !== "stored") || exp.missing.length > 0;
  return {
    businessId,
    counter,
    period: null,
    timezone,
    current,
    measured: cur.exists,
    expected: exp.value,
    difference: exp.value - current,
    action: exp.value === current && !ledgerOff ? "none" : "set",
    note: cur.exists ? null : "Storage was never measured for this business (the counter didn't exist before Phase 18).",
    source: RECOUNTABLE[counter].source,
    details: exp.details,
    plan: { record: exp.objects.filter((o) => o.ledgerState !== "stored"), markDeleted: exp.missing },
  };
}

// Applies a dry run's result. `expectedCurrent` = the dry run's `current`.
export async function applyRecount({ db, admin, bucket, businessId, counter, period = null, actor, reason, expectedCurrent, now = new Date() }) {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3) throw new MeteringError("reason-required", "A reason is required to apply a recount");
  const r = await computeRecount({ db, bucket, businessId, counter, period, now });
  if (r.current !== expectedCurrent) throw new MeteringError("changed-meanwhile", `The counter changed since the dry run (${expectedCurrent} → ${r.current}). Run the dry run again.`);
  if (r.action === "report-only") throw new MeteringError("never-lower", r.note);
  if (r.action === "none") return { ...r, applied: false };
  const { tenant } = await businessOf(db, businessId);
  const FieldValue = admin.firestore.FieldValue;
  const who = typeof actor === "string" && actor.trim() ? actor.trim() : "cli";

  if (METERS[counter].kind === "monthly") {
    await db.runTransaction(async (tx) => {
      const ref = usageMonthRef(tenant, period);
      const snap = await tx.get(ref);
      const now2 = snap.exists ? nonNegative(snap.data()[counter]) : 0;
      if (now2 !== r.current) throw new MeteringError("changed-meanwhile", "The counter changed while applying. Run the dry run again.");
      const stamp = FieldValue.serverTimestamp();
      tx.set(ref, { period, [counter]: r.expected, ...(snap.exists && snap.data().timezone ? {} : { timezone: r.timezone, timezones: FieldValue.arrayUnion(r.timezone) }), recountedAt: stamp, updatedAt: stamp }, { merge: true });
      writeRecountAudit(tx, db, tenant, { businessId, counter, period, actor: who, reason: why, before: r.current, after: r.expected, details: r.details, at: stamp });
    });
    return { ...r, applied: true };
  }

  // Storage: reconcile the ledger first (idempotent per object), then set
  // the totals from the ledger in one transaction.
  const stamp = FieldValue.serverTimestamp();
  for (const o of r.plan.record) {
    await storageLedgerRef(tenant, o.id).set({ schemaVersion: 1, path: o.path, bytes: o.bytes, area: o.path.split("/")[2] ?? null, state: "stored", source: "recount", recordType: null, recordId: null, finalizedAt: stamp, reservedAt: null, expiresAt: null, releasedAt: null, deletedAt: null }, { merge: true });
  }
  for (const o of r.plan.markDeleted) await storageLedgerRef(tenant, o.id).set({ state: "deleted", deletedAt: stamp, source: "recount" }, { merge: true });
  const result = await db.runTransaction(async (tx) => {
    const ref = usageCurrentRef(tenant, "storage");
    const [cur, stored, reserved] = await Promise.all([tx.get(ref), tx.get(tenant.collection("storageObjects").where("state", "==", "stored")), tx.get(tenant.collection("storageObjects").where("state", "==", "reserved"))]);
    const before = cur.exists ? nonNegative(cur.data().bytes) : 0;
    if (before !== r.current) throw new MeteringError("changed-meanwhile", "Storage changed while applying. Run the dry run again.");
    const bytes = stored.docs.reduce((s, d) => s + nonNegative(d.data().bytes), 0);
    const liveReserved = reserved.docs.filter((d) => millis(d.data().expiresAt) > now.getTime()).reduce((s, d) => s + nonNegative(d.data().bytes), 0);
    const at = FieldValue.serverTimestamp();
    tx.set(ref, { bytes, reservedBytes: liveReserved, objects: stored.size, recountedAt: at, updatedAt: at }, { merge: true });
    writeRecountAudit(tx, db, tenant, { businessId, counter, period: null, actor: who, reason: why, before, after: bytes, details: { ...r.details, recorded: r.plan.record.length, markedDeleted: r.plan.markDeleted.length }, at });
    return { bytes };
  });
  return { ...r, applied: true, after: result.bytes };
}

function writeRecountAudit(tx, db, tenant, { businessId, counter, period, actor, reason, before, after, details, at }) {
  const record = { type: "usage.recounted", summary: `${METERS[counter].label}${period ? ` (${period})` : ""} recounted: ${before} → ${after}`, businessId, counter, period, actor, reason, before: { value: before }, after: { value: after }, details, at };
  tx.set(tenant.collection("auditLog").doc(), record);
  tx.set(db.collection("platformAudit").doc(), record);
}
