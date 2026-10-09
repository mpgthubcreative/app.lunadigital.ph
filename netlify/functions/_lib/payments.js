// Payments service (server only). Each write is ONE Firestore transaction
// that reads the order (and the reference index), checks everything, then
// writes the payment record, the order's derived payment fields, metrics
// and gauges together. The browser never sets amountPaid, balances,
// statuses or verification.
//
// Documents (businesses/{bid}/...):
//   payments/{paymentId}         one record per payment, with its own history   (payments.view)
//   paymentRefs/{method_REF}     duplicate-reference guard, per business         (server only)
//   orders/{orderId}             amountPaid, verifiedPaid, pendingPaid, balance,
//                                paymentStatus, paymentCount, lastPaymentRef,
//                                lastProofPaymentId (+ statusHistory entries)
// Storage (server only, never public, no download tokens):
//   tenants/{bid}/payments/proofs/{orderId}/{paymentId}-{n}.{ext}
//
// Payments never touch Sales or COGS (those belong to fulfillment).

import { applyRollup, paymentContribution, diffRollup } from "./reports.js";
import { applyCustomerStats } from "./customers.js";
import { randomUUID } from "node:crypto";
import {
  PAYMENT_SCHEMA_VERSION,
  PAYMENT_METHODS,
  PROOF_MAX_BYTES,
  PROOF_TYPES,
  PaymentError,
  isValidPaymentId,
  normalizeReference,
  referenceKey,
  validatePaymentInput,
  derivePaymentStatus,
} from "../../../shared/payments.js";
import { isValidOrderId, MAX_HISTORY_ENTRIES } from "../../../shared/orders.js";
import { businessDate } from "../../../shared/metrics.js";
import { recordDailyMetrics, adjustCurrentMetrics } from "./metrics.js";
import { prepareNotifications, prepareResolution } from "./notifications.js";

const TX_OPTIONS = { maxAttempts: 10 };
const peso = (c) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------- Proof images ----------

// Real type from the file's first bytes, not from what the browser claims.
function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// proof: { contentType, dataBase64 } from the browser -> validated Buffer.
export function decodeProof(proof) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new PaymentError("invalid-proof", "Invalid screenshot");
  for (const key of Object.keys(proof)) if (!["contentType", "dataBase64"].includes(key)) throw new PaymentError("invalid-proof", "Invalid screenshot");
  if (typeof proof.dataBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(proof.dataBase64)) throw new PaymentError("invalid-proof", "Invalid screenshot data");
  const data = Buffer.from(proof.dataBase64, "base64");
  if (!data.length || data.length > PROOF_MAX_BYTES) throw new PaymentError("proof-too-large", `Screenshots must be under ${Math.floor(PROOF_MAX_BYTES / 1_000_000 * 10) / 10} MB`);
  const actual = sniffImage(data);
  if (!actual || !PROOF_TYPES[actual]) throw new PaymentError("invalid-proof", "Screenshots must be JPEG, PNG or WebP images");
  if (proof.contentType && proof.contentType !== actual) throw new PaymentError("invalid-proof", "The screenshot isn't the type it claims to be");
  return { data, contentType: actual };
}

async function storeProof(bucket, { businessId, orderId, paymentId, proof, actor }) {
  const path = `tenants/${businessId}/payments/proofs/${orderId}/${paymentId}-${randomUUID().slice(0, 8)}.${PROOF_TYPES[proof.contentType]}`;
  // No firebaseStorageDownloadTokens: the object is never reachable by URL.
  await bucket.file(path).save(proof.data, { resumable: false, contentType: proof.contentType, metadata: { metadata: { uploadedBy: actor.uid, orderId, paymentId } } });
  return { path, contentType: proof.contentType, size: proof.data.length, uploadedBy: actor, uploadedAt: new Date() };
}

const removeQuietly = async (bucket, path) => {
  try {
    await bucket.file(path).delete();
  } catch {
    /* best effort: an orphaned object is harmless and unreachable */
  }
};

// ---------- Helpers ----------

function refs(tenant, { orderId, paymentId }) {
  if (orderId !== undefined && !isValidOrderId(orderId)) throw new PaymentError("invalid-order", "Invalid order");
  if (paymentId !== undefined && !isValidPaymentId(paymentId)) throw new PaymentError("invalid-payment", "Invalid payment");
  return {
    order: orderId ? tenant.doc("orders", orderId) : null,
    payment: paymentId ? tenant.doc("payments", paymentId) : null,
  };
}

const append = (list, entry) => {
  const l = Array.isArray(list) ? list : [];
  if (l.length >= MAX_HISTORY_ENTRIES) throw new PaymentError("history-full", "Too many changes on this record");
  return [...l, entry];
};

// The order's derived payment fields after adding deltas to its sums.
function orderPaymentFields(order, { verifiedDelta = 0, pendingDelta = 0 }) {
  const verifiedPaid = (order.verifiedPaid || 0) + verifiedDelta;
  const pendingPaid = (order.pendingPaid || 0) + pendingDelta;
  const amountPaid = verifiedPaid + pendingPaid;
  if (verifiedPaid < 0 || pendingPaid < 0) throw new PaymentError("inconsistent", "Payment totals would go negative");
  if (amountPaid > order.total) throw new PaymentError("overpayment", `That's more than the remaining balance (${peso(order.total - (order.amountPaid || 0))})`);
  return { verifiedPaid, pendingPaid, amountPaid, balance: order.total - amountPaid, paymentStatus: derivePaymentStatus({ total: order.total, verifiedPaid, pendingPaid }) };
}

// Gauges follow the balance: receivables by the amount, unpaid-order count
// when a balance appears or disappears.
function balanceGauges(tx, { tenant, FieldValue, before, after }) {
  const unpaid = (after > 0 ? 1 : 0) - (before > 0 ? 1 : 0);
  if (after === before && !unpaid) return;
  adjustCurrentMetrics({ tx, tenant, FieldValue, ...(unpaid ? { operational: { unpaidOrders: unpaid } } : {}), ...(after !== before ? { financial: { receivablesOutstanding: after - before } } : {}) });
}

const historyAt = () => new Date();

// ---------- Record ----------

export async function recordPayment({ db, bucket, tenant, FieldValue, business, orderId, input, proof = null, actor, canVerify, now = new Date() }) {
  const data = validatePaymentInput(input);
  const r = refs(tenant, { orderId });
  const paymentRef = tenant.collection("payments").doc();
  const decoded = proof ? decodeProof(proof) : null;
  const day = businessDate(business.timezone, now);
  const key = referenceKey(data.method, data.reference);
  const stored = decoded ? await storeProof(await bucket(), { businessId: business.id, orderId, paymentId: paymentRef.id, proof: decoded, actor }) : null;

  try {
    return await db.runTransaction(async (tx) => {
      const orderSnap = await tx.get(r.order);
      if (!orderSnap.exists) throw new PaymentError("not-found", "Order not found");
      const order = orderSnap.data();
      if (order.fulfillmentStatus === "cancelled") throw new PaymentError("order-cancelled", "This order is cancelled");
      if (key && (await tx.get(tenant.doc("paymentRefs", key))).exists) throw new PaymentError("duplicate-reference", "This payment reference has already been used.");

      const verified = canVerify === true;
      const fields = orderPaymentFields(order, verified ? { verifiedDelta: data.amount } : { pendingDelta: data.amount });
      const label = PAYMENT_METHODS[data.method].label;
      // Phase 13: whoever can verify hears about a payment that needs it.
      const notes = verified
        ? null
        : await prepareNotifications(tx, {
            tenant,
            actor,
            events: [{ type: "payment.awaiting_verification", key: paymentRef.id, title: "Payment awaiting verification", message: `${peso(data.amount)} ${label} received for ${order.orderNumber}.`, recordType: "payment", recordId: paymentRef.id }],
          });
      const stamp = FieldValue.serverTimestamp();
      const payment = {
        schemaVersion: PAYMENT_SCHEMA_VERSION,
        orderId,
        orderNumber: order.orderNumber,
        customerName: order.customer?.name ?? "",
        amount: data.amount,
        method: data.method,
        reference: data.reference || null,
        referenceKey: key,
        note: data.note || null,
        proof: stored,
        state: verified ? "verified" : "for_verification",
        verifiedBy: verified ? actor : null,
        verifiedAt: verified ? stamp : null,
        receivedAt: now,
        receivedDay: day,
        revision: 1,
        history: [{ type: "recorded", at: historyAt(), actor, amount: data.amount, method: data.method, reference: data.reference || null, verified }],
        createdBy: actor,
        createdAt: stamp,
        updatedBy: actor,
        updatedAt: stamp,
      };
      tx.create(paymentRef, payment);
      if (key) tx.create(tenant.doc("paymentRefs", key), { paymentId: paymentRef.id, orderId, createdAt: stamp });
      tx.update(r.order, {
        ...fields,
        paymentCount: (order.paymentCount || 0) + 1,
        lastPaymentRef: data.reference || order.lastPaymentRef || null,
        ...(stored ? { lastProofPaymentId: paymentRef.id } : {}),
        statusHistory: append(order.statusHistory, { type: "payment", at: historyAt(), actor, paymentId: paymentRef.id, amount: data.amount, method: data.method, reference: data.reference || null, verified, label: `Payment recorded ${peso(data.amount)} via ${label}` }),
        updatedBy: actor,
        updatedAt: stamp,
      });
      recordDailyMetrics({ tx, tenant, FieldValue, timezone: business.timezone, day, financial: { paymentsReceived: data.amount } });
      applyRollup(tx, { tenant, FieldValue, day, delta: paymentContribution(data) });
      balanceGauges(tx, { tenant, FieldValue, before: order.total - (order.amountPaid || 0), after: fields.balance });
    applyCustomerStats(tx, { tenant, FieldValue, customerId: order.customerId, balance: fields.balance - (order.total - (order.amountPaid || 0)) });
      if (notes) notes.commit({ FieldValue });
      return { paymentId: paymentRef.id, orderId, state: payment.state, ...fields };
    }, TX_OPTIONS);
  } catch (err) {
    if (stored) await removeQuietly(await bucket(), stored.path);
    if (err && err.code === 6) throw new PaymentError("duplicate-reference", "This payment reference has already been used.");
    throw err;
  }
}

// ---------- Edit (payments.verify) ----------

// "Edit -> Save" on a payment: amount, method, reference, note, or a new
// screenshot. The order's sums, status, metrics and gauges follow; the
// payment's history records each before -> after.
export async function updatePayment({ db, bucket, tenant, FieldValue, business, paymentId, changes, proof = null, actor }) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new PaymentError("invalid-input", "Invalid changes");
  for (const k of Object.keys(changes)) if (!["amount", "method", "reference", "note"].includes(k)) throw new PaymentError("invalid-input", `Field ${k} can't be changed here`);
  const r = refs(tenant, { paymentId });
  const decoded = proof ? decodeProof(proof) : null;
  let stored = null;

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(r.payment);
      if (!snap.exists) throw new PaymentError("not-found", "Payment not found");
      const payment = snap.data();
      if (payment.state === "voided") throw new PaymentError("voided", "A voided payment can't be edited");
      const merged = validatePaymentInput({
        amount: changes.amount ?? payment.amount,
        method: changes.method ?? payment.method,
        reference: "reference" in changes ? changes.reference : payment.reference || "",
        note: "note" in changes ? changes.note : payment.note || "",
      });
      const orderRef = tenant.doc("orders", payment.orderId);
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) throw new PaymentError("not-found", "Order not found");
      const order = orderSnap.data();

      const newKey = referenceKey(merged.method, merged.reference);
      if (newKey && newKey !== payment.referenceKey && (await tx.get(tenant.doc("paymentRefs", newKey))).exists) {
        throw new PaymentError("duplicate-reference", "This payment reference has already been used.");
      }
      if (decoded && !stored) stored = await storeProof(await bucket(), { businessId: business.id, orderId: payment.orderId, paymentId, proof: decoded, actor });

      const delta = merged.amount - payment.amount;
      const verified = payment.state === "verified";
      const fields = orderPaymentFields(order, verified ? { verifiedDelta: delta } : { pendingDelta: delta });
      const entries = [];
      const at = historyAt();
      if (delta) entries.push({ type: "amount", at, actor, from: payment.amount, to: merged.amount, label: `Payment amount changed ${peso(payment.amount)} → ${peso(merged.amount)}` });
      if (merged.method !== payment.method) entries.push({ type: "method", at, actor, from: payment.method, to: merged.method, label: `Method changed ${PAYMENT_METHODS[payment.method].label} → ${PAYMENT_METHODS[merged.method].label}` });
      if ((merged.reference || null) !== (payment.reference || null)) entries.push({ type: "reference", at, actor, from: payment.reference, to: merged.reference || null, label: `Reference changed ${payment.reference || "—"} → ${merged.reference || "—"}` });
      if ((merged.note || null) !== (payment.note || null)) entries.push({ type: "note", at, actor, label: "Note changed" });
      if (stored) entries.push({ type: "proof", at, actor, previous: payment.proof?.path ?? null, label: payment.proof ? "Screenshot replaced" : "Screenshot added" });
      if (!entries.length) return { paymentId, unchanged: true };

      let history = payment.history || [];
      for (const e of entries) history = append(history, e);
      const stamp = FieldValue.serverTimestamp();
      tx.update(r.payment, {
        amount: merged.amount,
        method: merged.method,
        reference: merged.reference || null,
        referenceKey: newKey,
        note: merged.note || null,
        ...(stored ? { proof: stored } : {}),
        history,
        revision: (payment.revision || 1) + 1,
        updatedBy: actor,
        updatedAt: stamp,
      });
      if (newKey !== payment.referenceKey) {
        if (payment.referenceKey) tx.delete(tenant.doc("paymentRefs", payment.referenceKey));
        if (newKey) tx.create(tenant.doc("paymentRefs", newKey), { paymentId, orderId: payment.orderId, createdAt: stamp });
      }
      let orderHistory = order.statusHistory;
      for (const e of entries) orderHistory = append(orderHistory, { ...e, paymentId });
      tx.update(orderRef, {
        ...fields,
        ...(merged.reference && order.lastPaymentRef === payment.reference ? { lastPaymentRef: merged.reference } : {}),
        ...(stored ? { lastProofPaymentId: paymentId } : {}),
        statusHistory: orderHistory,
        updatedBy: actor,
        updatedAt: stamp,
      });
      // Report rollups: method / amount changes restate the received day.
      applyRollup(tx, { tenant, FieldValue, day: payment.receivedDay, delta: diffRollup(paymentContribution(merged), paymentContribution(payment)) });
      if (delta) {
        recordDailyMetrics({ tx, tenant, FieldValue, timezone: business.timezone, day: payment.receivedDay, financial: { paymentsReceived: delta } });
        balanceGauges(tx, { tenant, FieldValue, before: order.total - (order.amountPaid || 0), after: fields.balance });
    applyCustomerStats(tx, { tenant, FieldValue, customerId: order.customerId, balance: fields.balance - (order.total - (order.amountPaid || 0)) });
      }
      return { paymentId, orderId: payment.orderId, ...fields };
    }, TX_OPTIONS);
  } catch (err) {
    if (stored) await removeQuietly(await bucket(), stored.path);
    if (err && err.code === 6) throw new PaymentError("duplicate-reference", "This payment reference has already been used.");
    throw err;
  }
}

// ---------- Verify (payments.verify) ----------

export async function verifyPayment({ db, tenant, FieldValue, paymentId, actor }) {
  const r = refs(tenant, { paymentId });
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(r.payment);
    if (!snap.exists) throw new PaymentError("not-found", "Payment not found");
    const payment = snap.data();
    if (payment.state !== "for_verification") throw new PaymentError("not-pending-verification", payment.state === "verified" ? "This payment is already verified" : "A voided payment can't be verified");
    const orderRef = tenant.doc("orders", payment.orderId);
    const order = (await tx.get(orderRef)).data();
    const fields = orderPaymentFields(order, { verifiedDelta: payment.amount, pendingDelta: -payment.amount });
    const resolution = await prepareResolution(tx, { tenant, type: "payment.awaiting_verification", key: paymentId });
    const stamp = FieldValue.serverTimestamp();
    const entry = { type: "verified", at: historyAt(), actor, label: "Payment marked verified" };
    tx.update(r.payment, { state: "verified", verifiedBy: actor, verifiedAt: stamp, history: append(payment.history, entry), revision: (payment.revision || 1) + 1, updatedBy: actor, updatedAt: stamp });
    tx.update(orderRef, { ...fields, statusHistory: append(order.statusHistory, { ...entry, paymentId }), updatedBy: actor, updatedAt: stamp });
    resolution.commit({ FieldValue });
    return { paymentId, orderId: payment.orderId, ...fields };
  }, TX_OPTIONS);
}

// ---------- Void (payments.verify) ----------

// For an entry that should never have existed. The record stays (state
// "voided", who / when / why), its reference is freed, and it stops
// counting toward the order and the day's payments.
export async function voidPayment({ db, tenant, FieldValue, business, paymentId, reason, actor }) {
  const r = refs(tenant, { paymentId });
  const why = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ") : "";
  if (why.length < 3 || why.length > 300) throw new PaymentError("reason-required", "Say why this payment is being removed (3-300 characters)");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(r.payment);
    if (!snap.exists) throw new PaymentError("not-found", "Payment not found");
    const payment = snap.data();
    if (payment.state === "voided") throw new PaymentError("voided", "This payment is already removed");
    const orderRef = tenant.doc("orders", payment.orderId);
    const order = (await tx.get(orderRef)).data();
    const fields = orderPaymentFields(order, payment.state === "verified" ? { verifiedDelta: -payment.amount } : { pendingDelta: -payment.amount });
    const resolution = payment.state === "for_verification" ? await prepareResolution(tx, { tenant, type: "payment.awaiting_verification", key: paymentId }) : null;
    const stamp = FieldValue.serverTimestamp();
    const entry = { type: "voided", at: historyAt(), actor, reason: why, amount: payment.amount, label: `Payment removed ${peso(payment.amount)}` };
    tx.update(r.payment, { state: "voided", voidedBy: actor, voidedAt: stamp, voidReason: why, previousState: payment.state, referenceKey: null, history: append(payment.history, entry), revision: (payment.revision || 1) + 1, updatedBy: actor, updatedAt: stamp });
    if (payment.referenceKey) tx.delete(tenant.doc("paymentRefs", payment.referenceKey));
    tx.update(orderRef, {
      ...fields,
      paymentCount: Math.max(0, (order.paymentCount || 1) - 1),
      ...(order.lastProofPaymentId === paymentId ? { lastProofPaymentId: null } : {}),
      ...(order.lastPaymentRef && order.lastPaymentRef === payment.reference ? { lastPaymentRef: null } : {}),
      statusHistory: append(order.statusHistory, { ...entry, paymentId }),
      updatedBy: actor,
      updatedAt: stamp,
    });
    recordDailyMetrics({ tx, tenant, FieldValue, timezone: business.timezone, day: payment.receivedDay, financial: { paymentsReceived: -payment.amount } });
    applyRollup(tx, { tenant, FieldValue, day: payment.receivedDay, delta: diffRollup({}, paymentContribution(payment)) });
    balanceGauges(tx, { tenant, FieldValue, before: order.total - (order.amountPaid || 0), after: fields.balance });
    applyCustomerStats(tx, { tenant, FieldValue, customerId: order.customerId, balance: fields.balance - (order.total - (order.amountPaid || 0)) });
    if (resolution) resolution.commit({ FieldValue });
    return { paymentId, orderId: payment.orderId, voided: true, ...fields };
  }, TX_OPTIONS);
}

// ---------- Proof viewing (payments.view) ----------

// Returns the image bytes for a payment's screenshot, after confirming the
// payment belongs to this business and the object sits under its prefix.
export async function readProof({ tenant, bucket, businessId, paymentId }) {
  const r = refs(tenant, { paymentId });
  const snap = await r.payment.get();
  if (!snap.exists) throw new PaymentError("not-found", "Payment not found");
  const proof = snap.data().proof;
  if (!proof || typeof proof.path !== "string") throw new PaymentError("no-proof", "No screenshot on this payment");
  if (!proof.path.startsWith(`tenants/${businessId}/payments/proofs/`)) throw new PaymentError("not-found", "Payment not found");
  const [data] = await (await bucket()).file(proof.path).download();
  return { contentType: proof.contentType, dataBase64: data.toString("base64") };
}

export { normalizeReference };
