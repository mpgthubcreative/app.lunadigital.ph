// Luna Business public menu / order link (server only; Admin SDK).
// Rules and vocabulary: shared/storefront.js.
//
// Records:
//   businesses/{bid}/storefront/settings   the store's settings (server-only;
//                                           the Owner reads them through
//                                           /api/storefront)
//   storeSlugs/{slug}                      { businessId }: the menu link's
//                                           address, unique in Luna, top
//                                           level, server-only (rules deny)
//   storeThrottle/{sha256}                 public-order abuse guard per
//                                           (store, client) and per store
//                                           hour, server-only; expireAt for
//                                           a Firestore TTL policy
//
// A public order is created by the SAME createOrder() as a staff order
// (./orders.js): server prices, reservation, numbering, plan limit,
// metrics, customer stats. The actor is "Online store"; there is no
// discount and no saved-customer link. Staff are notified (order.online)
// in the same transaction. Fulfillment stays in Orders.

import { createHash, randomBytes } from "node:crypto";
import { tenantDb } from "./tenant-db.js";
import { createOrder } from "./orders.js";
import { accessPolicy } from "../../../shared/subscription.js";
import { validateEntitlementsSnapshot } from "../../../shared/entitlements.js";
import { isModuleEnabled } from "../../../shared/modules.js";
import {
  STOREFRONT_SCHEMA_VERSION,
  StorefrontError,
  defaultStoreSettings,
  validateStoreSettings,
  publicOrderInput,
  isStoreSlug,
  isPublicOrderKey,
  suggestStoreSlug,
  storePath,
  STORE_SLUG_MAX,
  STORE_LOW_STOCK_SHOWN,
  STORE_MAX_LINE_QTY,
  STORE_ORDER_LIMITS,
  STORE_PAYMENT_METHOD_IDS,
} from "../../../shared/storefront.js";
import { UNITS, QTY_SCALE } from "../../../shared/quantity.js";

const TX_OPTIONS = { maxAttempts: 10 };
export const STORE_ACTOR = Object.freeze({ uid: "online-store", name: "Online store", email: "" });
const MAX_PRODUCTS = 500;

const settingsRef = (tenant) => tenant.doc("storefront", "settings");
const slugRef = (db, slug) => db.collection("storeSlugs").doc(slug);
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
// One answer for "no such store", "moved" and "not available": a guess
// learns nothing about which businesses exist.
const NOT_FOUND = () => new StorefrontError("store-not-found", "This store link isn't valid. Ask the store for its current link.");

// Stored settings over the defaults (unknown / old fields dropped).
function settingsOf(snap, business) {
  const base = defaultStoreSettings(business);
  if (!snap.exists) return base;
  const d = snap.data();
  const out = { ...base };
  for (const k of Object.keys(base)) if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  if (!isStoreSlug(out.slug)) out.slug = null;
  out.paymentMethods = Array.isArray(out.paymentMethods) ? out.paymentMethods.filter((m) => STORE_PAYMENT_METHOD_IDS.includes(m)) : base.paymentMethods;
  out.hiddenProductIds = Array.isArray(out.hiddenProductIds) ? out.hiddenProductIds.filter((x) => typeof x === "string") : [];
  return out;
}

async function freeSlugFor(tx, db, businessId, base) {
  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? base : `${base.slice(0, STORE_SLUG_MAX - String(n).length - 1)}-${n}`;
    const snap = await tx.get(slugRef(db, candidate));
    if (!snap.exists || snap.data().businessId === businessId) return candidate;
  }
  return `${base.slice(0, STORE_SLUG_MAX - 7)}-${randomBytes(3).toString("hex")}`;
}
const baseSlug = (business) => {
  const s = suggestStoreSlug(business.name);
  return s.length >= 3 ? s : `store-${randomBytes(3).toString("hex")}`;
};

// ---- Owner side (/api/storefront) ----

// The settings, with a link name made from the business name on first use.
export async function readStoreSettings({ db, tenant, business, now = new Date() }) {
  const settings = await db.runTransaction(async (tx) => {
    const snap = await tx.get(settingsRef(tenant));
    const s = settingsOf(snap, business);
    if (s.slug) {
      const own = await tx.get(slugRef(db, s.slug));
      if (own.exists && own.data().businessId === tenant.businessId) return s;
    }
    s.slug = await freeSlugFor(tx, db, tenant.businessId, baseSlug(business));
    tx.set(slugRef(db, s.slug), { businessId: tenant.businessId, claimedAt: now });
    tx.set(settingsRef(tenant), { schemaVersion: STOREFRONT_SCHEMA_VERSION, ...s, updatedAt: now }, { merge: true });
    return s;
  }, TX_OPTIONS);
  return { settings, path: storePath(settings.slug) };
}

export async function saveStoreSettings({ db, tenant, FieldValue, business, input, actor, now = new Date() }) {
  const settings = await db.runTransaction(async (tx) => {
    const snap = await tx.get(settingsRef(tenant));
    const before = settingsOf(snap, business);
    const next = validateStoreSettings(input, before);
    if (!next.slug) next.slug = await freeSlugFor(tx, db, tenant.businessId, baseSlug(business));
    let old = null;
    if (next.slug !== before.slug) {
      const taken = await tx.get(slugRef(db, next.slug));
      if (taken.exists && taken.data().businessId !== tenant.businessId) throw new StorefrontError("slug-taken", `The link name "${next.slug}" is already used by another store. Try another, e.g. ${next.slug.slice(0, STORE_SLUG_MAX - 3)}-ph.`);
      old = before.slug ? await tx.get(slugRef(db, before.slug)) : null;
    }
    // Writes
    if (next.slug !== before.slug) {
      tx.set(slugRef(db, next.slug), { businessId: tenant.businessId, claimedAt: now });
      // The old link stops working (the store's settings no longer name it).
      if (old?.exists && old.data().businessId === tenant.businessId) tx.delete(old.ref);
    }
    tx.set(settingsRef(tenant), { schemaVersion: STOREFRONT_SCHEMA_VERSION, ...next, updatedBy: { uid: actor.uid, name: actor.name }, updatedAt: FieldValue.serverTimestamp() });
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    tx.set(tenant.collection("auditLog").doc(), { type: "storefront.settings_updated", changed, open: next.open, slug: next.slug, actor, at: FieldValue.serverTimestamp() });
    return next;
  }, TX_OPTIONS);
  return { settings, path: storePath(settings.slug) };
}

// ---- Public side (/api/store) ----

// slug -> the ONE business it belongs to, or NOT_FOUND. The store must be
// the business's CURRENT link, on an active (writable) subscription with
// valid entitlements that include Orders and Inventory.
export async function resolveStore({ db, slug }) {
  if (!isStoreSlug(slug)) throw NOT_FOUND();
  const link = await slugRef(db, slug).get();
  const businessId = link.exists ? link.data().businessId : null;
  if (typeof businessId !== "string") throw NOT_FOUND();
  let tenant;
  try {
    tenant = tenantDb(db, businessId);
  } catch {
    throw NOT_FOUND();
  }
  const [bSnap, sSnap] = await Promise.all([tenant.ref.get(), settingsRef(tenant).get()]);
  if (!bSnap.exists || !sSnap.exists) throw NOT_FOUND();
  const b = bSnap.data();
  const business = { id: businessId, name: b.name || "", timezone: b.timezone || "UTC", currency: b.currency || "PHP", orderPrefix: b.orderPrefix || null };
  const settings = settingsOf(sSnap, business);
  if (settings.slug !== slug) throw NOT_FOUND();
  const subscription = b.subscription || {};
  const check = validateEntitlementsSnapshot(b.entitlements, subscription.planId, b.workspaceTemplateId);
  if (!accessPolicy(subscription.status).canWrite || !check.ok || !isModuleEnabled(b.entitlements, "orders") || !isModuleEnabled(b.entitlements, "inventory")) throw NOT_FOUND();
  return { tenant, business, settings, entitlements: b.entitlements };
}

const unitLabel = (u) => UNITS[u]?.label ?? u ?? "";
// What a customer may see of one product (no cost, stock level, SKU or ids
// beyond the product id needed to order it).
function publicProduct(id, p) {
  const available = Number.isSafeInteger(p.available) ? p.available : 0;
  const low = available > 0 && available <= STORE_LOW_STOCK_SHOWN * QTY_SCALE;
  return {
    id,
    name: p.name || "",
    category: p.category || "",
    unit: p.unit,
    unitLabel: unitLabel(p.unit),
    price: p.sellingPrice,
    soldOut: available <= 0,
    // Only the "Only N left" figure is shown; above that, just a cap.
    left: low ? available : null,
    max: available <= 0 ? 0 : low ? available : STORE_MAX_LINE_QTY * QTY_SCALE,
  };
}

export async function viewStore({ db, slug }) {
  const { tenant, settings, business } = await resolveStore({ db, slug });
  const store = { name: settings.displayName || business.name, open: settings.open === true, note: settings.note || "", currency: business.currency, pickup: settings.pickup, delivery: settings.delivery, paymentMethods: settings.paymentMethods };
  if (!store.open) return { store, products: [] };
  const hidden = new Set(settings.hiddenProductIds);
  const snap = await tenant.collection("products").where("status", "==", "active").limit(MAX_PRODUCTS).get();
  const products = snap.docs
    .filter((d) => !hidden.has(d.id) && Number.isSafeInteger(d.data().sellingPrice) && d.data().sellingPrice > 0)
    .map((d) => publicProduct(d.id, d.data()))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return { store, products };
}

// The client's address, as Netlify reports it (never stored in clear).
export function clientKeyOf(event) {
  const h = event.headers || {};
  const raw = h["x-nf-client-connection-ip"] || (h["x-forwarded-for"] || "").split(",")[0] || h["client-ip"] || "unknown";
  return String(raw).trim().slice(0, 64) || "unknown";
}

// Counts the attempt or refuses it (too-many-orders). Its own small
// transaction BEFORE the order: a refused attempt creates nothing.
async function throttle({ db, businessId, clientKey, now }) {
  const t = now.getTime();
  const hour = Math.floor(t / 3600000);
  const clientRef = db.collection("storeThrottle").doc(sha(`client|${businessId}|${clientKey}`));
  const storeRef = db.collection("storeThrottle").doc(sha(`store|${businessId}|${hour}`));
  await db.runTransaction(async (tx) => {
    const [c, s] = await Promise.all([tx.get(clientRef), tx.get(storeRef)]);
    const cd = c.exists ? c.data() : null;
    const fresh = !cd || t - cd.windowStart >= STORE_ORDER_LIMITS.clientWindowMs;
    const clientCount = fresh ? 0 : cd.count;
    const storeCount = s.exists ? s.data().count : 0;
    if (clientCount >= STORE_ORDER_LIMITS.perClient || storeCount >= STORE_ORDER_LIMITS.perStoreHour) {
      throw new StorefrontError("too-many-orders", "Too many orders from here in a short time. Please wait a few minutes, or message the store directly.");
    }
    tx.set(clientRef, { windowStart: fresh ? t : cd.windowStart, count: clientCount + 1, expireAt: new Date(t + 24 * 3600000) });
    tx.set(storeRef, { count: storeCount + 1, expireAt: new Date(t + 48 * 3600000) });
  }, TX_OPTIONS);
}

const PUBLIC_MESSAGES = {
  "insufficient-stock": ["sold-out", "Some items just sold out or there isn't enough left. Check the quantities and try again."],
  "product-inactive": ["sold-out", "One of the products isn't available any more. Check your order and try again."],
  "not-found": ["sold-out", "One of the products isn't available any more. Check your order and try again."],
  "invalid-quantity": ["invalid-input", "Check the quantities and try again."],
  "order-limit-reached": ["store-unavailable", "This store can't take online orders right now. Please message the store directly."],
  "business-misconfigured": ["store-unavailable", "This store can't take online orders right now. Please message the store directly."],
  "idempotency-conflict": ["invalid-input", "Please refresh the page and place the order again."],
};

export async function placePublicOrder({ db, FieldValue, slug, idempotencyKey, input, clientKey = "unknown", now = new Date() }) {
  const store = await resolveStore({ db, slug });
  if (!store.settings.open) throw new StorefrontError("store-closed", "This store isn't taking orders right now.");
  if (!isPublicOrderKey(idempotencyKey)) throw new StorefrontError("invalid-input", "Please refresh the page and try again.");
  const orderInput = publicOrderInput(input, store.settings);
  await throttle({ db, businessId: store.business.id, clientKey, now });
  let result;
  try {
    result = await createOrder({
      db,
      tenant: store.tenant,
      FieldValue,
      business: store.business,
      entitlements: store.entitlements,
      input: orderInput,
      idempotencyKey,
      actor: STORE_ACTOR,
      canDiscount: false,
      canLinkCustomers: false,
      notify: (o) => [{ type: "order.online", key: o.orderId, title: `New online order ${o.orderNumber}`, message: `${o.customer.name} · ${o.items.length} ${o.items.length === 1 ? "item" : "items"} · ${o.sourceNote || "Online store"}`, recordType: "order", recordId: o.orderId }],
      now,
    });
  } catch (err) {
    const mapped = err && PUBLIC_MESSAGES[err.code];
    if (mapped) throw new StorefrontError(mapped[0], mapped[1]);
    if (err && err.code === "invalid-input" && err.message) throw new StorefrontError("invalid-input", err.message);
    throw err;
  }
  // The confirmation the customer sees (a retry of the same submit shows the same order).
  const order = result.order || (await store.tenant.doc("orders", result.orderId).get()).data();
  return {
    orderNumber: result.orderNumber,
    replayed: result.replayed === true,
    total: order.total,
    currency: store.business.currency,
    items: order.items.map((l) => ({ name: l.name, quantity: l.quantity, unitLabel: unitLabel(l.unit), lineSubtotal: l.lineSubtotal })),
    sourceNote: order.sourceNote || "",
  };
}
