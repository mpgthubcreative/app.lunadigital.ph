// Orders vocabulary, validation and totals. The ONE place order sources,
// statuses, numbering and totals are defined; server and UI both use it.
//
// Operational sales-recognition policy (NOT statutory revenue recognition):
//   created    reserve stock; count the order; NO sales, NO COGS
//   fulfilled  consume stock, snapshot the cost consumed per line, and
//              recognize sales, discount and COGS on the business-local
//              day of fulfillment
//   cancelled  (only from pending) release reservations; no sales, no COGS
// A fulfilled order can't be cancelled; reversals belong to Returns later.
// Payment is separate from fulfillment (Phase 8): new orders are unpaid.

import { isValidCustomerId } from "./customers.js";
import { isCentavos, lineAmount } from "./quantity.js";
import { ORDER_PAYMENT_STATUSES, derivePaymentStatus } from "./payments.js";

export const ORDER_SCHEMA_VERSION = 1;

export const ORDER_SOURCES = Object.freeze({
  messenger: { label: "Messenger" },
  facebook: { label: "Facebook" },
  viber: { label: "Viber" },
  phone: { label: "Phone" },
  walk_in: { label: "Walk-in" },
  website: { label: "Website" },
  other: { label: "Other", needsNote: true },
});
export const ORDER_SOURCE_IDS = Object.freeze(Object.keys(ORDER_SOURCES));

// Phase 18.6: order entry asks ONE plain question, "Where did the order
// come from?", in a single text box (e.g. "Viber", "Walk-in", "Messenger ·
// returning customer"). It still becomes the structured source id that
// filters and reports group by, plus the free-text sourceNote:
//   "Viber"                           -> viber, no note
//   "viber - returning customer"      -> viber, "returning customer"
//   "Returning customer"              -> other, "Returning customer"
//   "Facebook Messenger"              -> messenger (aliases below)
// sourceText() is the inverse, used to show / pre-fill the box.
const SOURCE_ALIASES = Object.freeze({
  "facebook messenger": "messenger",
  "fb messenger": "messenger",
  fb: "facebook",
  "phone call": "phone",
  call: "phone",
  text: "phone",
  sms: "phone",
  walkin: "walk_in",
  "walk in": "walk_in",
  "walk-in": "walk_in",
});
const sourceKey = (s) => s.toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
function sourceIdFor(label) {
  const k = sourceKey(label);
  if (Object.hasOwn(SOURCE_ALIASES, k)) return SOURCE_ALIASES[k];
  return ORDER_SOURCE_IDS.find((id) => id !== "other" && sourceKey(ORDER_SOURCES[id].label) === k) ?? null;
}
export const SOURCE_SEPARATOR = " · ";

export function sourceText(source, sourceNote) {
  const note = typeof sourceNote === "string" ? sourceNote.trim() : "";
  if (source === "other" || !ORDER_SOURCES[source]) return note;
  return note ? `${ORDER_SOURCES[source].label}${SOURCE_SEPARATOR}${note}` : ORDER_SOURCES[source].label;
}

// Returns { source, sourceNote } (sourceNote "" when none). Empty text ->
// { source: "other", sourceNote: "" }, which order validation refuses with
// "Say where the order came from".
export function parseSourceText(value) {
  const t = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!t) return { source: "other", sourceNote: "" };
  const whole = sourceIdFor(t);
  if (whole) return { source: whole, sourceNote: "" };
  // The first separator whose left side is a known source ("Walk-in - x"
  // must not split inside "Walk-in").
  for (const m of t.matchAll(/[·\-–—:,/(]/g)) {
    const id = sourceIdFor(t.slice(0, m.index));
    const note = t.slice(m.index + 1).replace(/\)\s*$/, "").trim();
    if (id && note) return { source: id, sourceNote: note };
  }
  return { source: "other", sourceNote: t };
}

// "open" stages hold reserved stock and can still be edited, fulfilled or
// cancelled; preparing / ready are operational stages for the Phase 8 row
// dropdown (no transition action yet). fulfilled and cancelled are final.
export const FULFILLMENT_STATUSES = Object.freeze({
  pending: { label: "Pending", open: true },
  preparing: { label: "Preparing", open: true },
  ready: { label: "Ready", open: true },
  fulfilled: { label: "Fulfilled", open: false },
  cancelled: { label: "Cancelled", open: false },
});

export const isOpenFulfillment = (status) => FULFILLMENT_STATUSES[status]?.open === true;

// Derived from payment records (shared/payments.js), never set directly.
export const PAYMENT_STATUSES = ORDER_PAYMENT_STATUSES;

export const MAX_ORDER_LINES = 50;
export const MAX_HISTORY_ENTRIES = 60;
export const DEFAULT_ORDER_PREFIX = "ORD";

export class OrderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const ORDER_ID = /^[A-Za-z0-9]{8,40}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const PREFIX = /^[A-Z0-9]{2,6}$/;
const PRODUCT_ID = /^[A-Za-z0-9]{8,40}$/;

export const isValidOrderId = (v) => typeof v === "string" && ORDER_ID.test(v);
export const isValidIdempotencyKey = (v) => typeof v === "string" && IDEMPOTENCY_KEY.test(v);
export const orderPrefixFor = (business) => (business && PREFIX.test(business.orderPrefix || "") ? business.orderPrefix : DEFAULT_ORDER_PREFIX);

// PREFIX-YYYYMMDD-### (### grows past 999 if needed), from the business-local day.
export function formatOrderNumber(prefix, dayId, seq) {
  return `${prefix}-${dayId.replace(/-/g, "")}-${String(seq).padStart(3, "0")}`;
}

function text(value, { field, max, required = false }) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new OrderError("invalid-input", `${field} must be text`);
  const t = value.trim().replace(/\s+/g, " ");
  if (required && !t) throw new OrderError("invalid-input", `${field} is required`);
  if (t.length > max) throw new OrderError("invalid-input", `${field} is too long (max ${max})`);
  return t;
}

// Validates the parts of an order the browser may supply. Quantities are
// checked against each product's unit later, by the inventory planner.
// Returns { customer, customerId, source, sourceNote, deliveryAddress, items: [{ productId, quantity }], discount, notes }.
// customerId (Phase 9) links a saved customer; the server then copies the
// name and phone from the customer record. Without it the order is a
// walk-in and the typed name is required.
export function validateOrderInput(input, { requireItems = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OrderError("invalid-input", "Invalid order");
  const allowed = ["customer", "customerId", "source", "sourceNote", "deliveryAddress", "items", "discount", "notes"];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new OrderError("invalid-input", `Field ${key} can't be set here`);

  const c = input.customer || {};
  if (typeof c !== "object" || Array.isArray(c)) throw new OrderError("invalid-input", "Invalid customer");
  for (const key of Object.keys(c)) if (!["name", "phone", "notes"].includes(key)) throw new OrderError("invalid-input", `Customer field ${key} can't be set`);
  const customerId = input.customerId === undefined || input.customerId === null ? null : input.customerId;
  if (customerId !== null && !isValidCustomerId(customerId)) throw new OrderError("invalid-input", "Invalid customer");
  const customer = {
    name: text(c.name, { field: "Customer name", max: 120, required: customerId === null }),
    phone: text(c.phone, { field: "Phone", max: 40 }),
    notes: text(c.notes, { field: "Customer notes", max: 300 }),
  };
  if (customer.phone && !/^[0-9+()\-. ]{3,40}$/.test(customer.phone)) throw new OrderError("invalid-input", "Phone may contain digits, spaces and + ( ) - . only");

  if (!ORDER_SOURCE_IDS.includes(input.source)) throw new OrderError("invalid-input", `Source must be one of ${ORDER_SOURCE_IDS.join(", ")}`);
  const sourceNote = text(input.sourceNote, { field: "Source note", max: 120 });
  if (ORDER_SOURCES[input.source].needsNote && !sourceNote) throw new OrderError("invalid-input", "Say where the order came from");
  // Optional: blank for pick-up / walk-in.
  const deliveryAddress = text(input.deliveryAddress, { field: "Delivery address", max: 300 });

  if (!Array.isArray(input.items)) throw new OrderError("invalid-input", "Items are required");
  if (requireItems && !input.items.length) throw new OrderError("invalid-input", "Add at least one product");
  if (input.items.length > MAX_ORDER_LINES) throw new OrderError("invalid-input", `At most ${MAX_ORDER_LINES} products per order`);
  const seen = new Set();
  const items = input.items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new OrderError("invalid-input", "Invalid item");
    for (const key of Object.keys(item)) if (!["productId", "quantity"].includes(key)) throw new OrderError("invalid-input", `Item field ${key} can't be set (prices and names come from the product)`);
    if (typeof item.productId !== "string" || !PRODUCT_ID.test(item.productId)) throw new OrderError("invalid-input", "Invalid product");
    if (seen.has(item.productId)) throw new OrderError("invalid-input", "Each product can appear once; combine the quantities");
    seen.add(item.productId);
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) throw new OrderError("invalid-quantity", "Quantity must be more than 0");
    return { productId: item.productId, quantity: item.quantity };
  });

  const discount = input.discount === undefined || input.discount === null ? 0 : input.discount;
  if (!isCentavos(discount)) throw new OrderError("invalid-discount", "Discount must be a whole number of centavos, 0 or more");

  return { customer, customerId, source: input.source, sourceNote, deliveryAddress, items, discount, notes: text(input.notes, { field: "Notes", max: 500 }) };
}

// Server-priced lines -> totals. lines: [{ quantity, unitPrice }].
// Subtotal = sum of line subtotals; Total = Subtotal - Discount (>= 0).
export function computeTotals(lines, discount = 0) {
  if (!isCentavos(discount)) throw new OrderError("invalid-discount", "Invalid discount");
  const priced = lines.map((l) => ({ ...l, lineSubtotal: lineAmount(l.quantity, l.unitPrice) }));
  const subtotal = priced.reduce((sum, l) => sum + l.lineSubtotal, 0);
  if (discount > subtotal) throw new OrderError("invalid-discount", "Discount can't be more than the subtotal");
  const total = subtotal - discount;
  return { lines: priced, subtotal, discount, total };
}

// A fulfilled-order correction needs a reason when it changes stock or money.
export function isMaterialChange({ before, after }) {
  const qty = (items) => JSON.stringify([...items].map((i) => [i.productId, i.quantity]).sort());
  return qty(before.items) !== qty(after.items) || before.discount !== after.discount;
}

export function paymentStatusFor({ total, verifiedPaid = 0, pendingPaid = 0 }) {
  return derivePaymentStatus({ total, verifiedPaid, pendingPaid });
}
