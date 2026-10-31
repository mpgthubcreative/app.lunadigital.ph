// Reseller Package service (server only; Admin SDK). Rules: shared/resellers.js.
//
// Documents (businesses/{bid}/..., every one server-only: the rules deny
// clients; the Owner reads through /api/resellers, the reseller through
// /api/reseller-menu with their private link):
//   resellers/{id}              { name, nameLower, notes, status, earned, paid,
//                                 orderCount, lastOrderAt, createdBy, ... }
//                               earned = Σ final commission of their orders
//                               that aren't cancelled (moved by ./orders.js
//                               in the same transaction as the order);
//                               paid = Σ payouts not reversed
//   resellerLinks/{resellerId}  { token, hash, createdAt, createdBy } the
//                               CURRENT private menu link (the Owner's Copy
//                               link reads it; like orderPayLinks)
//   resellerPrices/{resellerId}_{productId}  { price } the reseller's last
//                               selling price for a product (their default)
//   commissionPayouts/{id}      { resellerId, resellerName, amount, date, method,
//                               reference, notes, state: "paid" | "reversed",
//                               by, at, reversal? } a ledger: never overwritten
//   resellerMenuLinks/{sha256(token)}  top level: { businessId, resellerId }
// A link opens only when: its hash is on file → names a business and a
// reseller → that reseller's CURRENT link has this hash → the reseller is
// active → the business is a Reseller workspace on a writable subscription
// with Orders, Inventory and Resellers. Every other case: the same NOT_FOUND.
// Regenerate replaces the link (the old one stops at once); Deactivate stops
// it too. Riza's link only ever reads Riza's own orders and commission.

import { createHash, randomBytes } from "node:crypto";
import { tenantDb } from "./tenant-db.js";
import { createOrder } from "./orders.js";
import { payLinkFor } from "./pay-links.js";
import { accessPolicy } from "../../../shared/subscription.js";
import { validateEntitlementsSnapshot } from "../../../shared/entitlements.js";
import { isModuleEnabled } from "../../../shared/modules.js";
import { snapshotWorkspaceTemplateId } from "../../../shared/workspaces.js";
import { businessDate } from "../../../shared/metrics.js";
import { UNITS, QTY_SCALE, isCentavos } from "../../../shared/quantity.js";
import { STORE_FULFILLMENT, STORE_MAX_LINE_QTY, defaultStoreSettings } from "../../../shared/storefront.js";
import { PAYMENT_METHODS } from "../../../shared/payments.js";
import { isValidIdempotencyKey } from "../../../shared/orders.js";
import {
  RESELLER_SCHEMA_VERSION,
  MAX_RESELLERS,
  ResellerError,
  validateResellerInput,
  validatePayout,
  checkSellingPrice,
  commissionSummary,
  allocatePayouts,
  commissionReport,
  isResellerToken,
  isResellerId,
  resellerMenuPath,
  earnedOf,
  ownerAmountOf,
  PAYOUT_METHODS,
} from "../../../shared/resellers.js";

const TX_OPTIONS = { maxAttempts: 10 };
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const resellerRef = (tenant, id) => tenant.doc("resellers", id);
const ownLinkRef = (tenant, id) => tenant.doc("resellerLinks", id);
const menuLinkRef = (db, hash) => db.collection("resellerMenuLinks").doc(hash);
const priceRef = (tenant, resellerId, productId) => tenant.doc("resellerPrices", `${resellerId}_${productId}`);
const MAX_ORDERS_READ = 2000;
const PRODUCT = /^[A-Za-z0-9]{8,40}$/;
const iso = (v) => (v?.toDate ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : null);
const who = (actor) => ({ uid: actor.uid, name: actor.name ?? null });
const NOT_FOUND = () => new ResellerError("link-not-found", "This reseller link isn't valid. Ask the business for your current link.");

function audit(tx, tenant, entry) {
  tx.set(tenant.collection("auditLog").doc(), { ...entry, at: new Date() });
}
// status = Active / Inactive; payoutStatus = Unpaid / Partially Paid / Paid.
const rowOf = (id, r) => {
  const c = commissionSummary(r.earned, r.paid);
  return { id, name: r.name, notes: r.notes ?? null, status: r.status, orderCount: r.orderCount || 0, lastOrderAt: iso(r.lastOrderAt), earned: c.earned, paid: c.paid, remaining: c.remaining, payoutStatus: c.status };
};

// A new link (the old one, if any, stops working in the same transaction).
function issueLink(tx, { db, tenant, resellerId, previousHash = null, actor, now }) {
  const token = newToken();
  const hash = sha(token);
  if (previousHash) tx.delete(menuLinkRef(db, previousHash));
  tx.create(menuLinkRef(db, hash), { businessId: tenant.businessId, resellerId, createdAt: now });
  tx.set(ownLinkRef(tenant, resellerId), { token, hash, createdAt: now, createdBy: who(actor) });
  return { token, path: resellerMenuPath(token) };
}

// ---------- Owner side (/api/resellers) ----------

export async function listResellers({ tenant }) {
  const snap = await tenant.collection("resellers").limit(MAX_RESELLERS + 1).get();
  return snap.docs.map((d) => rowOf(d.id, d.data())).sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "active" ? -1 : 1));
}

// Name only (notes optional). The private link is made with it.
export async function createReseller({ db, tenant, FieldValue, input, actor, now = new Date() }) {
  const data = validateResellerInput(input);
  const count = (await tenant.collection("resellers").count().get()).data().count;
  if (count >= MAX_RESELLERS) throw new ResellerError("too-many", `Up to ${MAX_RESELLERS} resellers`);
  const ref = tenant.collection("resellers").doc();
  return db.runTransaction(async (tx) => {
    tx.create(ref, { schemaVersion: RESELLER_SCHEMA_VERSION, name: data.name, nameLower: data.name.toLocaleLowerCase("en"), notes: data.notes ?? null, status: "active", earned: 0, paid: 0, orderCount: 0, lastOrderAt: null, createdBy: who(actor), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    const link = issueLink(tx, { db, tenant, resellerId: ref.id, actor, now });
    audit(tx, tenant, { type: "reseller.created", resellerId: ref.id, name: data.name, actor: who(actor) });
    return { resellerId: ref.id, ...link };
  }, TX_OPTIONS);
}

export async function updateReseller({ db, tenant, FieldValue, resellerId, changes, actor }) {
  if (!isResellerId(resellerId)) throw new ResellerError("invalid-input", "Invalid reseller");
  const data = validateResellerInput(changes, { partial: true });
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(resellerRef(tenant, resellerId));
    if (!snap.exists) throw new ResellerError("not-found", "Reseller not found");
    const patch = { ...data, ...(data.name ? { nameLower: data.name.toLocaleLowerCase("en") } : {}), updatedAt: FieldValue.serverTimestamp() };
    tx.update(snap.ref, patch);
    audit(tx, tenant, { type: "reseller.updated", resellerId, before: { name: snap.data().name, notes: snap.data().notes ?? null }, after: data, actor: who(actor) });
    return { resellerId };
  }, TX_OPTIONS);
}

// Inactive: their link stops working at once; Active: it works again (the same link).
export async function setResellerStatus({ db, tenant, FieldValue, resellerId, status, actor }) {
  if (!isResellerId(resellerId)) throw new ResellerError("invalid-input", "Invalid reseller");
  if (status !== "active" && status !== "inactive") throw new ResellerError("invalid-input", "Choose Active or Inactive");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(resellerRef(tenant, resellerId));
    if (!snap.exists) throw new ResellerError("not-found", "Reseller not found");
    if (snap.data().status === status) return { resellerId, status, unchanged: true };
    tx.update(snap.ref, { status, updatedAt: FieldValue.serverTimestamp() });
    audit(tx, tenant, { type: status === "active" ? "reseller.reactivated" : "reseller.deactivated", resellerId, name: snap.data().name, actor: who(actor) });
    return { resellerId, status };
  }, TX_OPTIONS);
}

// The current link (made if missing), or a new one (rotate: the old link stops at once).
export async function resellerLink({ db, tenant, resellerId, rotate = false, actor, now = new Date() }) {
  if (!isResellerId(resellerId)) throw new ResellerError("invalid-input", "Invalid reseller");
  return db.runTransaction(async (tx) => {
    const [snap, own] = await Promise.all([tx.get(resellerRef(tenant, resellerId)), tx.get(ownLinkRef(tenant, resellerId))]);
    if (!snap.exists) throw new ResellerError("not-found", "Reseller not found");
    const cur = own.exists ? own.data() : null;
    if (cur && isResellerToken(cur.token) && !rotate) return { token: cur.token, path: resellerMenuPath(cur.token), created: false };
    const link = issueLink(tx, { db, tenant, resellerId, previousHash: cur?.hash ?? null, actor, now });
    audit(tx, tenant, { type: cur ? "reseller.link_regenerated" : "reseller.link_created", resellerId, name: snap.data().name, actor: who(actor) });
    return { ...link, created: true };
  }, TX_OPTIONS);
}

// Orders attributed to a reseller (any date; capped), as commission rows.
async function ordersOf(tenant, resellerId) {
  const snap = await tenant.collection("orders").where("resellerId", "==", resellerId).limit(MAX_ORDERS_READ).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
const commissionRow = (o) => ({ id: o.id, date: o.orderDate, final: earnedOf(o) });

// One reseller: summary, payouts (newest first) and recent orders with
// their oldest-first payout state.
export async function resellerDetail({ tenant, resellerId }) {
  if (!isResellerId(resellerId)) throw new ResellerError("invalid-input", "Invalid reseller");
  const snap = await resellerRef(tenant, resellerId).get();
  if (!snap.exists) throw new ResellerError("not-found", "Reseller not found");
  const r = snap.data();
  const [orders, payoutSnap] = await Promise.all([ordersOf(tenant, resellerId), tenant.collection("commissionPayouts").where("resellerId", "==", resellerId).limit(500).get()]);
  const alloc = allocatePayouts(orders.filter((o) => earnedOf(o) > 0 || o.fulfillmentStatus !== "cancelled").map(commissionRow), r.paid || 0);
  const payouts = payoutSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.date === b.date ? (iso(b.at) || "").localeCompare(iso(a.at) || "") : a.date < b.date ? 1 : -1));
  return {
    reseller: rowOf(snap.id, r),
    orders: orders
      .sort((a, b) => (a.orderDate === b.orderDate ? String(b.orderNumber).localeCompare(String(a.orderNumber)) : a.orderDate < b.orderDate ? 1 : -1))
      .slice(0, 50)
      .map((o) => ({ id: o.id, orderNumber: o.orderNumber, orderDate: o.orderDate, customer: o.customer?.name ?? "", total: o.total, fulfillmentStatus: o.fulfillmentStatus, paymentStatus: o.paymentStatus, commission: o.commission ?? null, payout: alloc.get(o.id) ?? null })),
    payouts: payouts.map((p) => ({ id: p.id, amount: p.amount, date: p.date, method: p.method ? PAYOUT_METHODS[p.method]?.label ?? p.method : null, reference: p.reference ?? null, notes: p.notes ?? null, state: p.state, by: p.by?.name ?? null, reversal: p.reversal ? { reason: p.reversal.reason, by: p.reversal.by?.name ?? null, at: iso(p.reversal.at) } : null })),
  };
}

// Pay Commission: one payout record; never more than what's still owed.
export async function payCommission({ db, tenant, FieldValue, business, resellerId, input, idempotencyKey, actor, now = new Date() }) {
  if (!isResellerId(resellerId)) throw new ResellerError("invalid-input", "Invalid reseller");
  if (!isValidIdempotencyKey(idempotencyKey)) throw new ResellerError("invalid-input", "Please refresh and try again");
  const today = businessDate(business?.timezone || "Asia/Manila", now);
  const ref = tenant.collection("commissionPayouts").doc(`cp${sha(`${tenant.businessId}|${resellerId}|${idempotencyKey}`).slice(0, 30)}`);
  return db.runTransaction(async (tx) => {
    const [prior, snap] = await Promise.all([tx.get(ref), tx.get(resellerRef(tenant, resellerId))]);
    if (prior.exists) return { payoutId: ref.id, alreadyRecorded: true, ...commissionSummary(snap.data()?.earned, snap.data()?.paid) };
    if (!snap.exists) throw new ResellerError("not-found", "Reseller not found");
    const r = snap.data();
    const data = validatePayout(input, { remaining: Math.max(0, (r.earned || 0) - (r.paid || 0)), today });
    tx.create(ref, { schemaVersion: RESELLER_SCHEMA_VERSION, resellerId, resellerName: r.name, ...data, state: "paid", by: who(actor), at: now });
    tx.update(snap.ref, { paid: FieldValue.increment(data.amount), updatedAt: FieldValue.serverTimestamp() });
    audit(tx, tenant, { type: "reseller.commission_paid", resellerId, payoutId: ref.id, amount: data.amount, date: data.date, actor: who(actor) });
    return { payoutId: ref.id, ...commissionSummary(r.earned, (r.paid || 0) + data.amount) };
  }, TX_OPTIONS);
}

// A payout recorded by mistake: reversed (kept in the ledger with the reason).
export async function reversePayout({ db, tenant, FieldValue, payoutId, reason, actor, now = new Date() }) {
  if (typeof payoutId !== "string" || !/^[A-Za-z0-9]{8,40}$/.test(payoutId)) throw new ResellerError("invalid-input", "Invalid payout");
  const why = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ") : "";
  if (why.length < 3 || why.length > 300) throw new ResellerError("reason-required", "Say why this payout is reversed (3-300 characters)");
  return db.runTransaction(async (tx) => {
    const pSnap = await tx.get(tenant.doc("commissionPayouts", payoutId));
    if (!pSnap.exists) throw new ResellerError("not-found", "Payout not found");
    const p = pSnap.data();
    if (p.state === "reversed") return { payoutId, unchanged: true };
    const rSnap = await tx.get(resellerRef(tenant, p.resellerId));
    tx.update(pSnap.ref, { state: "reversed", reversal: { reason: why, by: who(actor), at: now } });
    if (rSnap.exists) tx.update(rSnap.ref, { paid: FieldValue.increment(-p.amount), updatedAt: FieldValue.serverTimestamp() });
    audit(tx, tenant, { type: "reseller.payout_reversed", resellerId: p.resellerId, payoutId, amount: p.amount, reason: why, actor: who(actor) });
    return { payoutId, reversed: true };
  }, TX_OPTIONS);
}

// HOW MUCH COMMISSION DID EACH RESELLER EARN? (final commission, by the
// order's date; payouts settle the oldest first).
export async function resellerReport({ tenant, from, to }) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(from || "") || !day.test(to || "") || from > to) throw new ResellerError("invalid-input", "Choose a valid date range");
  const rSnap = await tenant.collection("resellers").limit(MAX_RESELLERS).get();
  const resellers = rSnap.docs.map((d) => ({ id: d.id, name: d.data().name, paid: d.data().paid || 0 }));
  // One equality query per reseller (single-field index; a handful of resellers).
  const lists = await Promise.all(resellers.map((r) => ordersOf(tenant, r.id)));
  const orders = lists.flat().map((o) => ({ id: o.id, resellerId: o.resellerId, date: o.orderDate, final: earnedOf(o) }));
  return commissionReport({ resellers, orders, from, to });
}

// ---------- Public side: the reseller's private menu (/api/reseller-menu) ----------

export async function resolveResellerLink({ db, token }) {
  if (!isResellerToken(token)) throw NOT_FOUND();
  const hash = sha(token);
  const link = await menuLinkRef(db, hash).get();
  if (!link.exists) throw NOT_FOUND();
  const { businessId, resellerId } = link.data();
  if (typeof businessId !== "string" || !isResellerId(resellerId)) throw NOT_FOUND();
  let tenant;
  try {
    tenant = tenantDb(db, businessId);
  } catch {
    throw NOT_FOUND();
  }
  const [bSnap, rSnap, own, sSnap] = await Promise.all([tenant.ref.get(), resellerRef(tenant, resellerId).get(), ownLinkRef(tenant, resellerId).get(), tenant.doc("storefront", "settings").get()]);
  if (!bSnap.exists || !rSnap.exists || !own.exists || own.data().hash !== hash || rSnap.data().status !== "active") throw NOT_FOUND();
  const b = bSnap.data();
  const subscription = b.subscription || {};
  const check = validateEntitlementsSnapshot(b.entitlements, subscription.planId, b.workspaceTemplateId);
  if (!accessPolicy(subscription.status).canWrite || !check.ok || snapshotWorkspaceTemplateId(b.entitlements) !== "reseller" || !["orders", "inventory", "resellers"].every((m) => isModuleEnabled(b.entitlements, m))) throw NOT_FOUND();
  const business = { id: businessId, name: b.name || "", timezone: b.timezone || "UTC", currency: b.currency || "PHP", orderPrefix: b.orderPrefix || null };
  const settings = { ...defaultStoreSettings(business), ...(sSnap.exists ? sSnap.data() : {}) };
  return { tenant, business, entitlements: b.entitlements, settings, reseller: { id: resellerId, ...rSnap.data() } };
}

const unitLabel = (u) => UNITS[u]?.label ?? u ?? "";
// A reseller meets their own customers: pickup or delivery, whatever the
// public store offers.
const waysOf = () => Object.keys(STORE_FULFILLMENT);

// What Riza sees: the business name, the products she can sell (owner price,
// her selling price, stock cap), her commission and her own orders. Never:
// costs, other resellers, business-wide figures.
export async function viewResellerMenu({ db, token }) {
  const { tenant, business, settings, reseller } = await resolveResellerLink({ db, token });
  const hidden = new Set(Array.isArray(settings.hiddenProductIds) ? settings.hiddenProductIds : []);
  const [pSnap, priceSnap, orders] = await Promise.all([tenant.collection("products").where("status", "==", "active").limit(500).get(), tenant.collection("resellerPrices").where("resellerId", "==", reseller.id).limit(500).get(), ordersOf(tenant, reseller.id)]);
  const mine = new Map(priceSnap.docs.map((d) => [d.data().productId, d.data().price]));
  const products = pSnap.docs
    .filter((d) => !hidden.has(d.id) && Number.isSafeInteger(d.data().sellingPrice) && d.data().sellingPrice > 0)
    .map((d) => {
      const p = d.data();
      const available = Number.isSafeInteger(p.available) ? p.available : 0;
      return { id: d.id, name: p.name || "", category: p.category || "", unit: p.unit, unitLabel: unitLabel(p.unit), ownerPrice: p.sellingPrice, sellingPrice: mine.has(d.id) && mine.get(d.id) >= p.sellingPrice ? mine.get(d.id) : p.sellingPrice, max: available >= QTY_SCALE ? Math.min(available - (available % QTY_SCALE), STORE_MAX_LINE_QTY * QTY_SCALE) : 0 };
    })
    .filter((p) => p.max > 0)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const alloc = allocatePayouts(orders.map(commissionRow), reseller.paid || 0);
  return {
    business: { name: settings.displayName || business.name, currency: business.currency },
    reseller: { name: reseller.name },
    commission: commissionSummary(reseller.earned, reseller.paid),
    fulfillment: waysOf(settings),
    paymentMethods: (Array.isArray(settings.paymentMethods) ? settings.paymentMethods : []).filter((m) => PAYMENT_METHODS[m]).map((id) => ({ id, label: PAYMENT_METHODS[id].label })),
    products,
    orders: orders
      .sort((a, b) => (a.orderDate === b.orderDate ? String(b.orderNumber).localeCompare(String(a.orderNumber)) : a.orderDate < b.orderDate ? 1 : -1))
      .slice(0, 30)
      .map((o) => ({ orderNumber: o.orderNumber, orderDate: o.orderDate, customer: o.customer?.name ?? "", total: o.total, ownerAmount: ownerAmountOf(o.items), commission: o.fulfillmentStatus === "cancelled" ? 0 : o.commission?.final ?? 0, payout: alloc.get(o.id)?.status ?? "none", paymentStatus: o.paymentStatus, fulfillmentStatus: o.fulfillmentStatus, items: (o.items || []).map((l) => ({ name: l.name, quantity: l.quantity, unitLabel: unitLabel(l.unit), sellingPrice: l.unitPrice, lineSubtotal: l.lineSubtotal })) })),
  };
}

// Her selling price for a product (remembered as her default). Never below
// the owner price.
export async function setResellerPrice({ db, token, productId, price, now = new Date() }) {
  const { tenant, reseller } = await resolveResellerLink({ db, token });
  if (typeof productId !== "string" || !PRODUCT.test(productId)) throw new ResellerError("invalid-input", "Invalid product");
  const p = await tenant.doc("products", productId).get();
  if (!p.exists || p.data().status !== "active") throw new ResellerError("invalid-input", "This product isn't available");
  checkSellingPrice(price, p.data().sellingPrice);
  await priceRef(tenant, reseller.id, productId).set({ resellerId: reseller.id, productId, price, updatedAt: now });
  return { productId, sellingPrice: price, commission: price - p.data().sellingPrice };
}

const clean = (v, max) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const ORDER_FIELDS = ["customerName", "customerPhone", "fulfillment", "address", "paymentMethod", "notes", "items"];

// Riza's order: tagged to Riza (from the link, never from the form), sold at
// her prices, with the owner price snapshot and the commission; the same
// createOrder() as every order (stock reservation, numbering, plan limit).
// Returns the customer's payment link (it shows the order total only).
export async function placeResellerOrder({ db, FieldValue, token, idempotencyKey, input, now = new Date() }) {
  const r = await resolveResellerLink({ db, token });
  if (!isValidIdempotencyKey(idempotencyKey)) throw new ResellerError("invalid-input", "Please refresh the page and try again");
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => !ORDER_FIELDS.includes(k))) throw new ResellerError("invalid-input", "Invalid order");
  const name = clean(input.customerName, 120);
  if (!name) throw new ResellerError("invalid-input", "Enter the customer's name");
  const phone = clean(input.customerPhone, 40);
  if (phone && (!/^[0-9+()\-. ]{7,40}$/.test(phone) || (phone.match(/\d/g) || []).length < 7)) throw new ResellerError("invalid-input", "Enter a mobile number like 0917 123 4567, or leave it blank");
  const ways = waysOf(r.settings);
  const fulfillment = input.fulfillment ?? (ways.length === 1 ? ways[0] : null);
  if (!ways.includes(fulfillment)) throw new ResellerError("invalid-input", "Choose pickup or delivery");
  const address = clean(input.address, 300);
  if (fulfillment === "delivery" && !address) throw new ResellerError("invalid-input", "Enter the delivery address");
  const methods = (Array.isArray(r.settings.paymentMethods) ? r.settings.paymentMethods : []).filter((m) => PAYMENT_METHODS[m]);
  const paymentMethod = input.paymentMethod ?? null;
  if (paymentMethod !== null && !methods.includes(paymentMethod)) throw new ResellerError("invalid-input", "Choose how the customer will pay");
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) throw new ResellerError("invalid-input", "Add at least one product");
  const prices = new Map();
  const items = [];
  for (const it of input.items) {
    if (!it || typeof it !== "object" || Object.keys(it).some((k) => !["productId", "quantity", "sellingPrice"].includes(k)) || typeof it.productId !== "string" || !PRODUCT.test(it.productId) || prices.has(it.productId)) throw new ResellerError("invalid-input", "One of the products isn't available");
    if (!Number.isSafeInteger(it.quantity) || it.quantity <= 0 || it.quantity % QTY_SCALE !== 0 || it.quantity > STORE_MAX_LINE_QTY * QTY_SCALE) throw new ResellerError("invalid-quantity", `Choose 1 to ${STORE_MAX_LINE_QTY} of each product`);
    if (!isCentavos(it.sellingPrice)) throw new ResellerError("invalid-price", "Enter a selling price for each product");
    prices.set(it.productId, it.sellingPrice);
    items.push({ productId: it.productId, quantity: it.quantity });
  }
  const sourceNote = [`Reseller · ${r.reseller.name}`, STORE_FULFILLMENT[fulfillment].label, paymentMethod ? PAYMENT_METHODS[paymentMethod].label : ""].filter(Boolean).join(" · ");
  const actor = { uid: `reseller-${r.reseller.id}`, name: `${r.reseller.name} (reseller link)`, email: "" };
  let result;
  try {
    result = await createOrder({
      db,
      tenant: r.tenant,
      FieldValue,
      business: r.business,
      entitlements: r.entitlements,
      input: { customer: { name, phone, notes: "" }, source: "other", sourceNote, deliveryAddress: fulfillment === "delivery" ? address : "", items, notes: clean(input.notes, 300) },
      idempotencyKey,
      actor,
      canDiscount: false,
      canLinkCustomers: false,
      reseller: { id: r.reseller.id, name: r.reseller.name, prices },
      notify: (o) => [{ type: "order.online", key: o.orderId, title: `New reseller order ${o.orderNumber}`, message: `${r.reseller.name} · ${o.customer.name} · ${o.items.length} ${o.items.length === 1 ? "item" : "items"}`, recordType: "order", recordId: o.orderId }],
      now,
    });
  } catch (err) {
    if (err && ["insufficient-stock", "product-inactive", "not-found"].includes(err.code)) throw new ResellerError("sold-out", "Some items just sold out or there isn't enough left. Check the quantities and try again.");
    if (err && ["below-owner-price", "invalid-price", "invalid-quantity", "invalid-input", "reseller-inactive", "order-limit-reached", "idempotency-conflict"].includes(err.code)) throw new ResellerError(err.code === "reseller-inactive" ? "link-not-found" : err.code, err.code === "order-limit-reached" ? "The business can't take orders right now. Please message them." : err.message);
    throw err;
  }
  // Her prices become her defaults (best effort; the order already holds them).
  await Promise.all([...prices.entries()].map(([productId, price]) => priceRef(r.tenant, r.reseller.id, productId).set({ resellerId: r.reseller.id, productId, price, updatedAt: now }).catch(() => null)));
  const order = result.order || (await r.tenant.doc("orders", result.orderId).get()).data();
  const pay = await payLinkFor({ db, tenant: r.tenant, orderId: result.orderId, actor, now }).catch(() => null);
  return {
    orderNumber: result.orderNumber,
    replayed: result.replayed === true,
    total: order.total,
    ownerAmount: ownerAmountOf(order.items),
    commission: order.commission?.final ?? 0,
    currency: r.business.currency,
    items: order.items.map((l) => ({ name: l.name, quantity: l.quantity, unitLabel: unitLabel(l.unit), sellingPrice: l.unitPrice, lineSubtotal: l.lineSubtotal })),
    payPath: pay?.path ?? null,
  };
}

// Her own order's payment link (the customer pays the business there; the
// Owner verifies). Another reseller's order number is simply "not found".
export async function resellerOrderPayLink({ db, token, orderNumber, now = new Date() }) {
  const r = await resolveResellerLink({ db, token });
  if (typeof orderNumber !== "string" || orderNumber.length > 40) throw new ResellerError("invalid-input", "Invalid order");
  const snap = await r.tenant.collection("orders").where("orderNumber", "==", orderNumber).limit(5).get();
  const doc = snap.docs.find((d) => d.data().resellerId === r.reseller.id);
  if (!doc) throw new ResellerError("not-found", "Order not found");
  const pay = await payLinkFor({ db, tenant: r.tenant, orderId: doc.id, actor: { uid: `reseller-${r.reseller.id}`, name: `${r.reseller.name} (reseller link)` }, now });
  return { payPath: pay.path };
}
