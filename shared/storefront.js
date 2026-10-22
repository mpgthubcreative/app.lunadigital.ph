// Luna Business public menu / order link (Owner pilot): the shared rules.
//
//   Owner copies the menu link (/store/{slug}) -> customer browses active
//   products, picks quantities (the total is computed as they tap), gives
//   name + mobile (+ address for delivery) -> submits -> ONE normal Luna
//   order through the same order engine as staff orders (source "Online
//   store", reserved, unpaid, pending) -> staff fulfil it from Orders.
//
// The slug is only an address: storeSlugs/{slug} = { businessId } (top
// level, server-only) resolves it to ONE business, and the store's own
// settings must still name that slug. Custom domains later resolve to the
// same businessId the same way (a host -> businessId lookup); nothing here
// is per-tenant code.
//
// What the public sees: the store's display name, its note, and for each
// visible ACTIVE product its name, unit, category and selling price, plus
// "sold out" / "only N left" (never the stock level beyond that, costs,
// SKUs' internals, staff or other businesses).

import { slugify } from "./wedding.js";
import { PAYMENT_METHODS } from "./payments.js";
import { isValidIdempotencyKey } from "./orders.js";
import { QTY_SCALE } from "./quantity.js";
import { cleanInstructions } from "./pay-links.js";

export const STOREFRONT_SCHEMA_VERSION = 1;
export const STORE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const STORE_SLUG_MIN = 3;
export const STORE_SLUG_MAX = 50;
export const isStoreSlug = (s) => typeof s === "string" && s.length >= STORE_SLUG_MIN && s.length <= STORE_SLUG_MAX && STORE_SLUG.test(s);
export const storePath = (slug) => `/store/${slug}`;
// "Hayst Kopi" -> "hayst-kopi" ("" when the name has no letters/digits).
export const suggestStoreSlug = (name) => slugify(name, STORE_SLUG_MAX);

// Payment choices a customer may pick (what they intend to pay with; the
// payment itself is still recorded by staff in Orders).
export const STORE_PAYMENT_METHOD_IDS = Object.freeze(["cash", "cod", "gcash", "maya", "bank_transfer"]);
export const STORE_FULFILLMENT = Object.freeze({ pickup: { label: "Pickup" }, delivery: { label: "Delivery" } });

export const MAX_HIDDEN_PRODUCTS = 500;
// The public page shows "Only N left" at or below this; above it, nothing.
export const STORE_LOW_STOCK_SHOWN = 5;
// The most a customer can order of one product in one order (also capped
// by what's available).
export const STORE_MAX_LINE_QTY = 99;

// Abuse guard for the public order endpoint (per store).
export const STORE_ORDER_LIMITS = Object.freeze({ perClient: 5, clientWindowMs: 10 * 60 * 1000, perStoreHour: 60 });

export class StorefrontError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function defaultStoreSettings(business = {}) {
  return { open: false, displayName: (business.name || "").slice(0, 80), slug: null, note: "", pickup: true, delivery: false, paymentMethods: ["cash", "gcash"], hiddenProductIds: [], paymentInstructions: "" };
}

const PRODUCT_ID = /^[A-Za-z0-9]{8,40}$/;
const clean = (v, { field, max, required = false }) => {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new StorefrontError("invalid-input", `${field} must be text`);
  const t = v.replace(/\s+/g, " ").trim();
  if (required && !t) throw new StorefrontError("invalid-input", `${field} is required`);
  if (t.length > max) throw new StorefrontError("invalid-input", `${field} is too long (max ${max})`);
  return t;
};

// Owner settings. Partial input is merged over `current`; the result is the
// whole, valid settings object.
export const STORE_SETTING_FIELDS = Object.freeze(["open", "displayName", "slug", "note", "pickup", "delivery", "paymentMethods", "hiddenProductIds", "paymentInstructions"]);
export function validateStoreSettings(input, current) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new StorefrontError("invalid-input", "Invalid settings");
  for (const k of Object.keys(input)) if (!STORE_SETTING_FIELDS.includes(k)) throw new StorefrontError("invalid-input", `Setting ${k} can't be changed here`);
  const out = { ...current };
  for (const k of ["open", "pickup", "delivery"]) {
    if (!Object.hasOwn(input, k)) continue;
    if (typeof input[k] !== "boolean") throw new StorefrontError("invalid-input", "Invalid setting");
    out[k] = input[k];
  }
  if (Object.hasOwn(input, "displayName")) out.displayName = clean(input.displayName, { field: "Store name", max: 80, required: true });
  if (Object.hasOwn(input, "note")) out.note = clean(input.note, { field: "Note to customers", max: 200 });
  // 2026-10-22: shown on order payment links (shared/pay-links.js).
  if (Object.hasOwn(input, "paymentInstructions")) out.paymentInstructions = cleanInstructions(input.paymentInstructions, StorefrontError);
  if (Object.hasOwn(input, "slug")) {
    const s = typeof input.slug === "string" ? input.slug.trim().toLowerCase() : input.slug;
    if (!isStoreSlug(s)) throw new StorefrontError("invalid-input", `The link name can use lowercase letters, numbers and hyphens (${STORE_SLUG_MIN}–${STORE_SLUG_MAX} characters), e.g. hayst-kopi`);
    out.slug = s;
  }
  if (Object.hasOwn(input, "paymentMethods")) {
    const list = input.paymentMethods;
    if (!Array.isArray(list) || list.some((m) => !STORE_PAYMENT_METHOD_IDS.includes(m))) throw new StorefrontError("invalid-input", "Choose payment methods from the list");
    out.paymentMethods = STORE_PAYMENT_METHOD_IDS.filter((m) => list.includes(m));
  }
  if (Object.hasOwn(input, "hiddenProductIds")) {
    const list = input.hiddenProductIds;
    if (!Array.isArray(list) || list.length > MAX_HIDDEN_PRODUCTS || list.some((id) => typeof id !== "string" || !PRODUCT_ID.test(id))) throw new StorefrontError("invalid-input", "Invalid product list");
    out.hiddenProductIds = [...new Set(list)];
  }
  if (!out.pickup && !out.delivery) throw new StorefrontError("invalid-input", "Turn on pickup, delivery or both");
  if (!out.displayName) throw new StorefrontError("invalid-input", "Store name is required");
  return out;
}

// What a customer sends. Returns the order input for the normal order
// engine (shared/orders.js validateOrderInput checks it again), so a public
// order is a plain Luna order: source "online_store", the choice of pickup
// / delivery and payment method in the source note, no discount, no saved
// customer link.
export const PUBLIC_ORDER_FIELDS = Object.freeze(["name", "phone", "fulfillment", "address", "paymentMethod", "notes", "items"]);
export function publicOrderInput(input, settings) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new StorefrontError("invalid-input", "Invalid order");
  for (const k of Object.keys(input)) if (!PUBLIC_ORDER_FIELDS.includes(k)) throw new StorefrontError("invalid-input", "Invalid order");
  const name = clean(input.name, { field: "Your name", max: 120, required: true });
  const phone = clean(input.phone, { field: "Mobile number", max: 40, required: true });
  if (!/^[0-9+()\-. ]{7,40}$/.test(phone) || (phone.match(/\d/g) || []).length < 7) throw new StorefrontError("invalid-input", "Enter a mobile number we can reach you on, e.g. 0917 123 4567");
  const ways = Object.keys(STORE_FULFILLMENT).filter((k) => settings[k]);
  const fulfillment = input.fulfillment ?? (ways.length === 1 ? ways[0] : null);
  if (!ways.includes(fulfillment)) throw new StorefrontError("invalid-input", ways.length > 1 ? "Choose pickup or delivery" : `This store offers ${STORE_FULFILLMENT[ways[0]].label.toLowerCase()} only`);
  const address = clean(input.address, { field: "Delivery address", max: 300, required: fulfillment === "delivery" });
  const methods = settings.paymentMethods || [];
  const paymentMethod = input.paymentMethod ?? null;
  if (methods.length && !methods.includes(paymentMethod)) throw new StorefrontError("invalid-input", "Choose how you'll pay");
  if (!methods.length && paymentMethod !== null) throw new StorefrontError("invalid-input", "Invalid payment method");
  const notes = clean(input.notes, { field: "Notes", max: 300 });
  if (!Array.isArray(input.items) || !input.items.length) throw new StorefrontError("invalid-input", "Add at least one product");
  const hidden = new Set(settings.hiddenProductIds || []);
  for (const item of input.items) {
    if (item && typeof item === "object" && Object.keys(item).some((k) => k !== "productId" && k !== "quantity")) throw new StorefrontError("invalid-input", "Invalid order");
    if (!item || typeof item !== "object" || typeof item.productId !== "string" || !PRODUCT_ID.test(item.productId) || hidden.has(item.productId)) throw new StorefrontError("invalid-input", "One of the products isn't available");
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > STORE_MAX_LINE_QTY * QTY_SCALE) throw new StorefrontError("invalid-quantity", `Choose 1 to ${STORE_MAX_LINE_QTY} of each product`);
  }
  const sourceNote = [STORE_FULFILLMENT[fulfillment].label, paymentMethod ? PAYMENT_METHODS[paymentMethod].label : ""].filter(Boolean).join(" · ");
  return {
    customer: { name, phone, notes: "" },
    source: "online_store",
    sourceNote,
    deliveryAddress: fulfillment === "delivery" ? address : "",
    items: input.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    notes,
  };
}

export const isPublicOrderKey = isValidIdempotencyKey;
