// Order payment links (server only; shared/pay-links.js has the rules).
//
// Documents:
//   orderPayLinks/{sha256(token)}             { businessId, orderId, createdAt }   top level, server only
//   businesses/{bid}/orderPayLinks/{orderId}  { token, hash, createdAt, createdBy } server only (the Owner's
//                                             View / Copy link reads it through the API)
//   payThrottle/{sha256(...)}                 abuse counters for the public submit (server only)
// A link opens only when: the token's hash is on file → it names a business
// and order → that order's CURRENT link has this hash → the business is on a
// writable subscription with valid entitlements that include Orders and
// Payments → the order exists. Every other case is the same NOT_FOUND.
//
// The customer sees the business name, the order number, the name on the
// order, total / paid / awaiting verification / due, the payment
// instructions, and this order's payments (receipts for verified ones).
// Never: items, costs, notes, other orders or customers, staff names.
//
// A submit is an ordinary Luna payment (./payments.js recordPayment), never
// verified on its own: state "for_verification", via "payment_link", with
// the order's customerId. Its id comes from the submit key, so a double tap
// or a retry records it once.

import { createHash, randomBytes } from "node:crypto";
import { tenantDb } from "./tenant-db.js";
import { recordPayment } from "./payments.js";
import { paymentInstructionsOf } from "./storefront.js";
import { accessPolicy } from "../../../shared/subscription.js";
import { validateEntitlementsSnapshot } from "../../../shared/entitlements.js";
import { linkBusinessId } from "./custom-links.js";
import { isModuleEnabled } from "../../../shared/modules.js";
import { isValidOrderId, isValidIdempotencyKey } from "../../../shared/orders.js";
import { PaymentError, PAYMENT_METHODS } from "../../../shared/payments.js";
import { isPayToken, payPath, validatePublicPayment, PAY_LINK_LIMITS, PAY_LINK_METHOD_IDS } from "../../../shared/pay-links.js";

const TX_OPTIONS = { maxAttempts: 10 };
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
export const hashPayToken = (token) => sha(token);
const newToken = () => randomBytes(24).toString("base64url");
const linkRef = (db, hash) => db.collection("orderPayLinks").doc(hash);
const ownRef = (tenant, orderId) => tenant.doc("orderPayLinks", orderId);
export const PAY_LINK_ACTOR = Object.freeze({ uid: "payment-link", name: "Customer (payment link)", email: "" });
const NOT_FOUND = () => new PaymentError("link-not-found", "This payment link isn't valid. Ask the business for the current link.");

// ---------- Owner side (payments.record; rotate: payments.verify) ----------

// The order's link: the current one, or a new one (rotate replaces it: the
// old link stops working at once).
export async function payLinkFor({ db, tenant, orderId, actor, rotate = false, now = new Date() }) {
  if (!isValidOrderId(orderId)) throw new PaymentError("invalid-order", "Invalid order");
  return db.runTransaction(async (tx) => {
    const [orderSnap, ownSnap] = await Promise.all([tx.get(tenant.doc("orders", orderId)), tx.get(ownRef(tenant, orderId))]);
    if (!orderSnap.exists) throw new PaymentError("not-found", "Order not found");
    if (orderSnap.data().fulfillmentStatus === "cancelled") throw new PaymentError("order-cancelled", "This order is cancelled");
    const own = ownSnap.exists ? ownSnap.data() : null;
    if (own && isPayToken(own.token) && !rotate) return { token: own.token, path: payPath(own.token), created: false };
    const token = newToken();
    const hash = hashPayToken(token);
    if (own?.hash) tx.delete(linkRef(db, own.hash));
    tx.create(linkRef(db, hash), { businessId: tenant.businessId, orderId, createdAt: now });
    tx.set(ownRef(tenant, orderId), { token, hash, createdAt: now, createdBy: { uid: actor.uid, name: actor.name } });
    tx.set(tenant.collection("auditLog").doc(), { type: own ? "paylink.rotated" : "paylink.created", orderId, orderNumber: orderSnap.data().orderNumber, actor, at: now });
    return { token, path: payPath(token), created: true };
  }, TX_OPTIONS);
}

// An order deleted or a link to drop: both documents go (best effort).
export async function dropPayLink({ db, tenant, orderId }) {
  const own = await ownRef(tenant, orderId).get();
  if (!own.exists) return;
  if (own.data().hash) await linkRef(db, own.data().hash).delete();
  await ownRef(tenant, orderId).delete();
}

// ---------- Public side (/api/pay) ----------

// host: the custom workspace address the page is on (its label), if any:
// a link only opens on its own workspace's address (2026-10-26).
export async function resolvePayLink({ db, token, host = null }) {
  if (!isPayToken(token)) throw NOT_FOUND();
  const hash = hashPayToken(token);
  const link = await linkRef(db, hash).get();
  if (!link.exists) throw NOT_FOUND();
  const { businessId, orderId } = link.data();
  if (typeof businessId !== "string" || !isValidOrderId(orderId)) throw NOT_FOUND();
  if (host !== null && (await linkBusinessId(db, host)) !== businessId) throw NOT_FOUND();
  let tenant;
  try {
    tenant = tenantDb(db, businessId);
  } catch {
    throw NOT_FOUND();
  }
  const [bSnap, ownSnap, orderSnap] = await Promise.all([tenant.ref.get(), ownRef(tenant, orderId).get(), tenant.doc("orders", orderId).get()]);
  if (!bSnap.exists || !ownSnap.exists || ownSnap.data().hash !== hash || !orderSnap.exists) throw NOT_FOUND();
  const b = bSnap.data();
  const subscription = b.subscription || {};
  const check = validateEntitlementsSnapshot(b.entitlements, subscription.planId, b.workspaceTemplateId);
  if (!accessPolicy(subscription.status).canWrite || !check.ok || !isModuleEnabled(b.entitlements, "orders") || !isModuleEnabled(b.entitlements, "payments")) throw NOT_FOUND();
  const business = { id: businessId, name: b.name || "", timezone: b.timezone || "UTC", currency: b.currency || "PHP" };
  return { tenant, business, orderId, order: orderSnap.data(), hash };
}

const dayOf = (p) => p.receivedDay || null;
// The name on the order; a walk-in's placeholder name isn't shown.
const customerOf = (order) => (/^walk-?in$/i.test((order.customer?.name || "").trim()) ? "" : order.customer?.name || "");
// One payment as the customer sees it (their own order's payments only).
function publicPayment(p, { business, order }) {
  const out = { amount: p.amount, method: PAYMENT_METHODS[p.method]?.label ?? p.method, reference: p.reference || null, date: dayOf(p), state: p.state === "voided" ? "not_accepted" : p.state };
  // Why a submitted payment wasn't accepted (the Owner wrote it for the customer).
  if (p.state === "voided" && p.via === "payment_link") out.reason = p.voidReason || null;
  if (p.state === "verified") out.receipt = { business: business.name, orderNumber: order.orderNumber, customer: customerOf(order), amount: p.amount, method: out.method, reference: p.reference || null, date: dayOf(p), status: "Verified" };
  return out;
}

export async function viewPayLink({ db, token, host = null }) {
  const { tenant, business, order, orderId } = await resolvePayLink({ db, token, host });
  const [instructions, snap] = await Promise.all([paymentInstructionsOf(tenant, business), tenant.collection("payments").where("orderId", "==", orderId).limit(50).get()]);
  const at = (p) => (p.receivedAt && typeof p.receivedAt.toMillis === "function" ? p.receivedAt.toMillis() : new Date(p.receivedAt || 0).getTime());
  // Oldest first; the order's own history settles payments made the same moment.
  const seq = new Map((order.statusHistory || []).filter((h) => h.type === "payment").map((h, i) => [h.paymentId, i]));
  const payments = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    // A payment removed by the business for its own reasons stays private;
    // a customer's own submission that wasn't accepted is shown with why.
    .filter((p) => p.state !== "voided" || p.via === "payment_link")
    .sort((a, b) => at(a) - at(b) || (seq.get(a.id) ?? 0) - (seq.get(b.id) ?? 0))
    .map((p) => publicPayment(p, { business, order }));
  const cancelled = order.fulfillmentStatus === "cancelled";
  const due = Math.max(0, order.total - (order.verifiedPaid || 0) - (order.pendingPaid || 0));
  return {
    business: { name: business.name },
    currency: business.currency,
    order: {
      orderNumber: order.orderNumber,
      customer: customerOf(order),
      total: order.total,
      paid: order.verifiedPaid || 0,
      pending: order.pendingPaid || 0,
      due,
      payable: !cancelled && due > 0,
      cancelled,
    },
    instructions,
    methods: PAY_LINK_METHOD_IDS.map((id) => ({ id, label: PAYMENT_METHODS[id].label })),
    payments,
  };
}

// Counts the attempt or refuses it (too-many-payments). Its own small
// transaction BEFORE the payment: a refused attempt creates nothing.
async function throttle({ db, hash, clientKey, now }) {
  const t = now.getTime();
  const hour = Math.floor(t / 3600000);
  const clientRef = db.collection("payThrottle").doc(sha(`client|${hash}|${clientKey}`));
  const linkHourRef = db.collection("payThrottle").doc(sha(`link|${hash}|${hour}`));
  await db.runTransaction(async (tx) => {
    const [c, l] = await Promise.all([tx.get(clientRef), tx.get(linkHourRef)]);
    const cd = c.exists ? c.data() : null;
    const fresh = !cd || t - cd.windowStart >= PAY_LINK_LIMITS.clientWindowMs;
    const clientCount = fresh ? 0 : cd.count;
    const linkCount = l.exists ? l.data().count : 0;
    if (clientCount >= PAY_LINK_LIMITS.perClient || linkCount >= PAY_LINK_LIMITS.perOrderHour) {
      throw new PaymentError("too-many-payments", "Too many tries from here in a short time. Please wait a few minutes, or message the business directly.");
    }
    tx.set(clientRef, { windowStart: fresh ? t : cd.windowStart, count: clientCount + 1, expireAt: new Date(t + 24 * 3600000) });
    tx.set(linkHourRef, { count: linkCount + 1, expireAt: new Date(t + 48 * 3600000) });
  }, TX_OPTIONS);
}

// Plain answers for the customer (no internal wording).
const PUBLIC_MESSAGES = {
  "duplicate-reference": "This reference number was already submitted. Check it, or message the business if you think this is a mistake.",
  "storage-limit-reached": "The business can't receive screenshots right now. Enter the reference number instead.",
  "storage-reservation-lost": "Something went wrong uploading the screenshot. Please try again.",
  "business-misconfigured": "This payment link isn't available right now. Please message the business directly.",
  inconsistent: "Something went wrong. Please refresh the page and try again.",
  "history-full": "This order can't take more payments online. Please message the business directly.",
};

export async function submitPayLink({ db, bucket, FieldValue, token, idempotencyKey, input, proof = null, clientKey = "unknown", now = new Date(), host = null }) {
  const link = await resolvePayLink({ db, token, host });
  const { tenant, business, orderId, order, hash } = link;
  if (!isValidIdempotencyKey(idempotencyKey)) throw new PaymentError("invalid-input", "Please refresh the page and try again.");
  // The same submit again (a double tap, a retry): the payment it made.
  const paymentId = `pl${sha(`${business.id}|${orderId}|${idempotencyKey}`).slice(0, 30)}`;
  const existing = await tenant.doc("payments", paymentId).get();
  if (existing.exists) return { alreadyRecorded: true, state: existing.data().state };
  if (order.fulfillmentStatus === "cancelled") throw new PaymentError("order-cancelled", "This order was cancelled. Please message the business.");
  const data = validatePublicPayment(input, { hasProof: Boolean(proof) });
  // Never more than what's due (paid and awaiting verification both count);
  // ./payments.js checks again inside its transaction.
  const due = order.total - (order.verifiedPaid || 0) - (order.pendingPaid || 0);
  if (due <= 0) throw new PaymentError("nothing-due", "This order is already fully paid. Please verify this payment before continuing.");
  if (data.amount > due) throw new PaymentError("overpayment", `That's more than the amount due (₱${(due / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}).`);
  await throttle({ db, hash, clientKey, now });
  try {
    const r = await recordPayment({
      db,
      bucket,
      tenant,
      FieldValue,
      business,
      orderId,
      input: { amount: data.amount, method: data.method, ...(data.reference ? { reference: data.reference } : {}) },
      proof,
      actor: PAY_LINK_ACTOR,
      canVerify: false,
      now,
      paymentId,
      // detected: what the screenshot reader found (shared/pay-links.js), apart from the confirmed amount / reference.
      extra: { via: "payment_link", customerId: order.customerId || null, ...(data.detected ? { detected: data.detected } : {}) },
    });
    return { alreadyRecorded: Boolean(r.alreadyRecorded), state: r.state ?? "for_verification" };
  } catch (err) {
    const msg = err && PUBLIC_MESSAGES[err.code];
    if (msg) throw new PaymentError(err.code, msg);
    if (err && err.code === "overpayment") throw new PaymentError("overpayment", "That's more than the amount due. Please refresh the page to see the current amount.");
    throw err;
  }
}
