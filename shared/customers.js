// Distributor customers (Phase 9). A customer is someone a distributor sells
// to: a store, a reseller, a walk-in regular. This is deliberately NOT a
// generic contacts/people engine: wedding guests, suppliers, household
// staff and providers will be their own domain records when those
// workspaces are built.
//
// The browser may supply only the contact fields below. Order statistics
// (order count, total ordered, outstanding balance, last order) are
// written by the server in the same transaction as the order or payment
// that changes them; nothing else can set them.

export const CUSTOMER_SCHEMA_VERSION = 1;

export const CUSTOMER_STATUSES = Object.freeze({
  active: { label: "Active" },
  inactive: { label: "Inactive" },
});

export const CUSTOMER_FIELDS = Object.freeze(["name", "company", "phone", "email", "address", "notes"]);

// Same shape as order and product ids: Firestore auto-ids are 20 characters.
export const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9]{8,40}$/;

export class CustomerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function text(value, { field, max, required = false }) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new CustomerError("invalid-input", `${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new CustomerError("invalid-input", `${field} must be text`);
  const t = value.trim().replace(/\s+/g, " ");
  if (!t) {
    if (required) throw new CustomerError("invalid-input", `${field} is required`);
    return null;
  }
  if (t.length > max) throw new CustomerError("invalid-input", `${field} is too long (max ${max})`);
  return t;
}

export const isValidCustomerId = (id) => typeof id === "string" && CUSTOMER_ID_PATTERN.test(id);

// Digits only, with a Philippine +63 mobile folded to its 0-prefixed form,
// so "+63 917 123 4567" and "0917-123-4567" match. Used to WARN about a
// possible duplicate, never to block (households and shops share numbers).
export function phoneKey(phone) {
  if (typeof phone !== "string") return null;
  let d = phone.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("63")) d = `0${d.slice(2)}`;
  return d.length >= 7 ? d : null;
}

// Full validation for a new customer; `partial` for an edit (only the keys
// present change). Returns the cleaned fields.
export function validateCustomerInput(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CustomerError("invalid-input", "Invalid customer");
  for (const key of Object.keys(input)) if (!CUSTOMER_FIELDS.includes(key)) throw new CustomerError("invalid-input", `Field ${key} can't be set here`);
  const has = (k) => !partial || Object.hasOwn(input, k);
  const out = {};
  if (has("name")) out.name = text(input.name, { field: "Customer name", max: 120, required: true });
  if (has("company")) out.company = text(input.company, { field: "Company", max: 120 });
  if (has("phone")) {
    out.phone = text(input.phone, { field: "Phone", max: 40 });
    if (out.phone && !/^[0-9+()\-. ]{3,40}$/.test(out.phone)) throw new CustomerError("invalid-input", "Phone may contain digits, spaces and + ( ) - . only");
  }
  if (has("email")) {
    out.email = text(input.email, { field: "Email", max: 254 });
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new CustomerError("invalid-input", "That email doesn't look right");
    if (out.email) out.email = out.email.toLowerCase();
  }
  if (has("address")) out.address = text(input.address, { field: "Address", max: 300 });
  if (has("notes")) out.notes = text(input.notes, { field: "Notes", max: 500 });
  if (partial && !Object.keys(out).length) throw new CustomerError("invalid-input", "Nothing to change");
  return out;
}

// What an order copies from a saved customer (the order keeps its own
// snapshot, so later contact edits never rewrite past orders).
export function customerSnapshot(customer, notes = null) {
  return { name: customer.name, phone: customer.phone || null, notes: notes || null };
}

export const EMPTY_CUSTOMER_STATS = Object.freeze({ orderCount: 0, totalOrdered: 0, outstandingBalance: 0, lastOrderAt: null, lastOrderNumber: null });
