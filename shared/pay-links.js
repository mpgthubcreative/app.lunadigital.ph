// Order payment links (Distributor, 2026-10-22). Each payable order can
// have ONE public link, /pay/{token}, that the business sends to the
// customer. The customer opens it without a Luna account, sees the order's
// amount due and the business's payment instructions, and submits a
// payment: GCash / Maya / bank transfer, with a screenshot or the reference
// number (one is enough). A submitted payment is always "For verification"
// until someone with payments.verify verifies it in Luna.
//
// The token is the only credential: 24 random bytes (base64url, 32
// characters), stored by its SHA-256 and revocable (a new link replaces it).
// The server answers every bad, revoked or foreign link the same way.

import { PaymentError, validatePaymentInput } from "./payments.js";

export const PAY_LINK_METHOD_IDS = Object.freeze(["gcash", "maya", "bank_transfer"]);
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
export const isPayToken = (v) => typeof v === "string" && TOKEN.test(v);
export const payPath = (token) => `/pay/${token}`;
// /pay/{token} -> token ("" when the path isn't a payment link).
export function payTokenFrom(pathname) {
  const m = /^\/pay\/([^/?#]+)\/?$/.exec(pathname || "");
  return m && isPayToken(m[1]) ? m[1] : "";
}

// Abuse guard for the public submit (per order link).
export const PAY_LINK_LIMITS = Object.freeze({ perClient: 6, clientWindowMs: 10 * 60 * 1000, perOrderHour: 20 });

// The payment instructions a business shows its customers (GCash number,
// bank account…). Lines are kept (they're usually one per account).
export const MAX_PAYMENT_INSTRUCTIONS = 500;
export function cleanInstructions(value, ErrorType = Error) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ErrorType("invalid-input", "Payment instructions must be text");
  const lines = value.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim());
  const t = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length > MAX_PAYMENT_INSTRUCTIONS) throw new ErrorType("invalid-input", `Payment instructions are too long (max ${MAX_PAYMENT_INSTRUCTIONS})`);
  return t;
}

// What a customer may send: amount (centavos), method, reference. The same
// rules as a payment recorded in Luna (shared/payments.js), limited to the
// methods a link offers.
export function validatePublicPayment(input, { hasProof = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PaymentError("invalid-input", "Invalid payment");
  for (const k of Object.keys(input)) if (!["amount", "method", "reference", "detected"].includes(k)) throw new PaymentError("invalid-input", "Invalid payment");
  if (!PAY_LINK_METHOD_IDS.includes(input.method)) throw new PaymentError("invalid-input", "Choose GCash, Maya or bank transfer");
  const out = validatePaymentInput({ amount: input.amount, method: input.method, reference: input.reference ?? "" }, { hasProof });
  const detected = detectedOf(input.detected);
  return { amount: out.amount, method: out.method, reference: out.reference, ...(detected ? { detected } : {}) };
}

// What the screenshot reader found (2026-10-26), kept APART from what the
// customer confirmed: it's never accounting truth, only a note for the
// business when it verifies. Anything odd is dropped, never an error.
//   { amount?: centavos, reference?: text, method?: id, date?: YYYY-MM-DD }
export function detectedOf(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const out = {};
  if (Number.isSafeInteger(d.amount) && d.amount > 0 && d.amount <= 100_000_000_00) out.amount = d.amount;
  if (typeof d.reference === "string" && /^[A-Za-z0-9]{4,40}$/.test(d.reference)) out.reference = d.reference.toUpperCase();
  if (PAY_LINK_METHOD_IDS.includes(d.method)) out.method = d.method;
  if (typeof d.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) out.date = d.date;
  return Object.keys(out).length ? out : null;
}
