// Payments vocabulary, validation and the order payment-state derivation.
// Server and UI both use this; the browser never decides amounts paid,
// balances or statuses.
//
// An order can have many payment records (businesses/{bid}/payments/{id}).
// Each record is "for_verification" (recorded by someone without
// payments.verify), "verified", or "voided" (kept for history, counts for
// nothing). The order carries derived totals:
//   amountPaid   = sum of non-voided payments (verified + for verification)
//   balance      = total - amountPaid             (never negative: no overpayment)
//   paymentStatus = unpaid | for_verification | partial | paid   (derivePaymentStatus)
// Payment is separate from fulfillment and never moves Sales or COGS.

import { isCentavos, MAX_CENTAVOS } from "./quantity.js";

export const PAYMENT_SCHEMA_VERSION = 1;

export const PAYMENT_METHODS = Object.freeze({
  cash: { label: "Cash", referenceRequired: false, uniqueReference: false },
  gcash: { label: "GCash", referenceRequired: true, uniqueReference: true },
  maya: { label: "Maya", referenceRequired: true, uniqueReference: true },
  bank_transfer: { label: "Bank transfer", referenceRequired: true, uniqueReference: true },
  cod: { label: "COD", referenceRequired: false, uniqueReference: false },
  other: { label: "Other", referenceRequired: false, uniqueReference: true },
});
export const PAYMENT_METHOD_IDS = Object.freeze(Object.keys(PAYMENT_METHODS));

export const PAYMENT_STATES = Object.freeze({
  for_verification: { label: "For verification" },
  verified: { label: "Verified" },
  voided: { label: "Voided" },
});

// Order-level payment status labels (shared/orders.js PAYMENT_STATUSES uses these ids).
export const ORDER_PAYMENT_STATUSES = Object.freeze({
  unpaid: { label: "Unpaid" },
  for_verification: { label: "For verification" },
  partial: { label: "Partially paid" },
  paid: { label: "Paid" },
});

// Proof images: the browser downsizes before upload; the server re-checks.
export const PROOF_MAX_BYTES = 2_500_000;
export const PROOF_TYPES = Object.freeze({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" });

export class PaymentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const PAYMENT_ID = /^[A-Za-z0-9]{8,40}$/;
export const isValidPaymentId = (v) => typeof v === "string" && PAYMENT_ID.test(v);

// "0917-123 4567" / "abc 123" -> "09171234567" / "ABC123". Letters and digits
// only, so formatting differences can't sneak a duplicate past the index.
export function normalizeReference(input) {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") throw new PaymentError("invalid-reference", "Reference must be text");
  const ref = input.toUpperCase().replace(/[\s\-_.\/#]/g, "");
  if (ref && !/^[A-Z0-9]{4,40}$/.test(ref)) throw new PaymentError("invalid-reference", "Reference must be 4-40 letters or digits");
  return ref;
}

// Index key for duplicate detection (businesses/{bid}/paymentRefs/{key}).
export function referenceKey(method, reference) {
  return PAYMENT_METHODS[method]?.uniqueReference && reference ? `${method}_${reference}` : null;
}

// Validates what the browser may send for a payment. Amount is centavos.
export function validatePaymentInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PaymentError("invalid-input", "Invalid payment");
  for (const key of Object.keys(input)) {
    if (!["amount", "method", "reference", "note"].includes(key)) throw new PaymentError("invalid-input", `Field ${key} can't be set here`);
  }
  if (!PAYMENT_METHOD_IDS.includes(input.method)) throw new PaymentError("invalid-input", `Method must be one of ${PAYMENT_METHOD_IDS.join(", ")}`);
  if (!isCentavos(input.amount) || input.amount <= 0 || input.amount > MAX_CENTAVOS) throw new PaymentError("invalid-amount", "Amount must be more than ₱0");
  const reference = normalizeReference(input.reference);
  if (PAYMENT_METHODS[input.method].referenceRequired && !reference) throw new PaymentError("reference-required", `${PAYMENT_METHODS[input.method].label} payments need a reference number`);
  const note = typeof input.note === "string" ? input.note.trim().replace(/\s+/g, " ") : "";
  if (note.length > 300) throw new PaymentError("invalid-input", "Note is too long (max 300)");
  return { amount: input.amount, method: input.method, reference, note };
}

// Order payment status from trusted sums (never from a browser string).
export function derivePaymentStatus({ total, verifiedPaid = 0, pendingPaid = 0 }) {
  const paid = verifiedPaid + pendingPaid;
  if (paid <= 0) return "unpaid";
  if (pendingPaid > 0) return "for_verification";
  return paid >= total ? "paid" : "partial";
}

// Is the order still owed money (counts toward "unpaid orders")?
export const hasBalance = ({ total, verifiedPaid = 0, pendingPaid = 0 }) => total - verifiedPaid - pendingPaid > 0;
