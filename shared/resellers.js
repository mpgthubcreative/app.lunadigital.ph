// Reseller Package (2026-10-31): rules shared by the server, the Owner's
// screens and the reseller's private menu link. Pure functions, no I/O.
//
// The model, kept deliberately small:
//   Owner/Base Price      the product's price (products/{id}.sellingPrice):
//                         what the business expects for one unit
//   Selling Price         what the reseller charges the customer for one unit
//                         (>= the owner price); the order line's unitPrice
//   Calculated Commission (selling − owner) × qty, summed over the order
//   Final Commission      what counts: the calculated one, or the Owner's
//                         override (both kept; "Adjusted from ₱150")
//   Commission Paid       payouts (Business → Reseller), a ledger of records,
//                         never one overwritten amount; separate from the
//                         customer's payments (Customer → Business)
//   Status                Unpaid / Partially Paid / Paid from final vs paid
// Payouts are made to a reseller, not to one order. Where a per-order view is
// needed (export, report), payouts settle the OLDEST earned commission first.
// Earned date = the order's date; payout date is its own (a commission earned
// in October and paid in November stays October's).

import { isCentavos, lineAmount, MAX_CENTAVOS } from "./quantity.js";

export const RESELLER_SCHEMA_VERSION = 1;
export const RESELLER_NAME_MAX = 60;
export const RESELLER_NOTES_MAX = 300;
export const MAX_RESELLERS = 200;
export const RESELLER_STATUSES = Object.freeze({ active: { label: "Active" }, inactive: { label: "Inactive" } });
export const COMMISSION_STATUSES = Object.freeze({ none: { label: "No commission" }, unpaid: { label: "Unpaid" }, partial: { label: "Partially Paid" }, paid: { label: "Paid" } });
export const PAYOUT_METHODS = Object.freeze({ cash: { label: "Cash" }, gcash: { label: "GCash" }, maya: { label: "Maya" }, bank_transfer: { label: "Bank Transfer" }, other: { label: "Other" } });
export const PAYOUT_METHOD_IDS = Object.freeze(Object.keys(PAYOUT_METHODS));
// The reseller's private menu link: /reseller#<token> (the token never goes
// to the server as part of a page address).
export const RESELLER_TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
export const isResellerToken = (t) => typeof t === "string" && RESELLER_TOKEN.test(t);
export const resellerMenuPath = (token) => `/reseller#${token}`;
const ID = /^[A-Za-z0-9]{8,40}$/;
export const isResellerId = (id) => typeof id === "string" && ID.test(id);

export class ResellerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const clean = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

// Name is the only required field. changes: only the keys given.
export function validateResellerInput(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ResellerError("invalid-input", "Invalid reseller");
  for (const k of Object.keys(input)) if (!["name", "notes"].includes(k)) throw new ResellerError("invalid-input", `Unknown field ${k}`);
  const out = {};
  if (!partial || "name" in input) {
    const name = clean(input.name);
    if (!name) throw new ResellerError("invalid-input", "Enter the reseller's name");
    if (name.length > RESELLER_NAME_MAX) throw new ResellerError("invalid-input", `Name: up to ${RESELLER_NAME_MAX} characters`);
    out.name = name;
  }
  if ("notes" in input) {
    const notes = typeof input.notes === "string" ? input.notes.trim().slice(0, RESELLER_NOTES_MAX + 1) : input.notes === null ? "" : null;
    if (notes === null) throw new ResellerError("invalid-input", "Invalid notes");
    if (notes.length > RESELLER_NOTES_MAX) throw new ResellerError("invalid-input", `Notes: up to ${RESELLER_NOTES_MAX} characters`);
    out.notes = notes || null;
  }
  return out;
}

// A selling price (centavos): a whole amount, at least the owner price.
// ₱0 commission (selling = owner) is valid; below the owner price is refused
// with a plain message (never a silent negative commission).
export const BELOW_OWNER_PRICE = "Selling price is below the owner price.";
export function checkSellingPrice(price, basePrice) {
  if (!isCentavos(price)) throw new ResellerError("invalid-price", "Enter a selling price, e.g. 650 or 650.50");
  if (Number.isSafeInteger(basePrice) && price < basePrice) throw new ResellerError("below-owner-price", BELOW_OWNER_PRICE);
  return price;
}

// One line's commission: what the customer pays minus what the business
// expects, at the order line's own price snapshots. The same rounding as the
// line subtotal, so commission + owner amount = customer total exactly.
export function lineCommission({ quantity, unitPrice, basePrice }) {
  if (!Number.isSafeInteger(basePrice)) return 0;
  return lineAmount(quantity, unitPrice) - lineAmount(quantity, basePrice);
}
export const orderCalculatedCommission = (lines) => (Array.isArray(lines) ? lines : []).reduce((t, l) => t + lineCommission(l), 0);
export const ownerAmountOf = (lines) => (Array.isArray(lines) ? lines : []).reduce((t, l) => t + (Number.isSafeInteger(l.basePrice) ? lineAmount(l.quantity, l.basePrice) : l.lineSubtotal ?? lineAmount(l.quantity, l.unitPrice)), 0);

// An order's commission block from its calculated figure and the previous
// block: an Owner override is kept (never silently destroyed); otherwise
// final follows calculated.
export function commissionFor(calculated, previous = null) {
  if (previous && previous.adjusted === true && Number.isSafeInteger(previous.final)) return { calculated, final: previous.final, adjusted: true, ...(previous.adjustedBy ? { adjustedBy: previous.adjustedBy } : {}), ...(previous.adjustedAt ? { adjustedAt: previous.adjustedAt } : {}) };
  return { calculated, final: Math.max(0, calculated), adjusted: false };
}
// What an order contributes to its reseller's earned total right now.
export const earnedOf = (order) => (order && order.resellerId && order.fulfillmentStatus !== "cancelled" && Number.isSafeInteger(order.commission?.final) ? order.commission.final : 0);

export function validateFinalCommission(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTAVOS) throw new ResellerError("invalid-amount", "Enter a commission of ₱0 or more");
  return value;
}

// Unpaid / Partially Paid / Paid from the amounts themselves (never stored
// separately, so it can't drift from them).
export function payoutStatus(earned, paid) {
  const e = Number.isSafeInteger(earned) ? earned : 0;
  const p = Number.isSafeInteger(paid) ? paid : 0;
  if (e <= 0 && p <= 0) return "none";
  if (p <= 0) return "unpaid";
  if (p < e) return "partial";
  return "paid";
}
export const remainingOf = (earned, paid) => Math.max(0, (earned || 0) - (paid || 0));
export const commissionSummary = (earned, paid) => ({ earned: earned || 0, paid: paid || 0, remaining: remainingOf(earned, paid), status: payoutStatus(earned, paid) });

// A payout (Business → Reseller). amount <= remaining: no overpayment, no
// negative balance.
export function validatePayout(input, { remaining, today }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ResellerError("invalid-input", "Invalid payout");
  for (const k of Object.keys(input)) if (!["amount", "date", "method", "reference", "notes"].includes(k)) throw new ResellerError("invalid-input", `Unknown field ${k}`);
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new ResellerError("invalid-amount", "Enter an amount more than ₱0");
  if (input.amount > remaining) throw new ResellerError("commission-overpaid", remaining > 0 ? `That's more than the commission still owed (₱${(remaining / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}).` : "Nothing is owed to this reseller right now.");
  const date = input.date === undefined || input.date === null || input.date === "" ? today : input.date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new ResellerError("invalid-input", "Choose the payment date");
  if (today && date > today) throw new ResellerError("invalid-input", "The payment date can't be in the future");
  const method = input.method === undefined || input.method === null || input.method === "" ? null : input.method;
  if (method !== null && !PAYOUT_METHOD_IDS.includes(method)) throw new ResellerError("invalid-input", "Choose how it was paid");
  const reference = clean(input.reference).slice(0, 80) || null;
  const notes = clean(input.notes).slice(0, RESELLER_NOTES_MAX) || null;
  return { amount: input.amount, date, method, reference, notes };
}

// Payouts settle the oldest earned commission first. orders: [{ id, date,
// final }] (any order); paid: the reseller's total paid. Returns a Map id ->
// { final, paid, remaining, status }.
export function allocatePayouts(orders, paid) {
  let left = Math.max(0, paid || 0);
  const out = new Map();
  const sorted = [...orders].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id).localeCompare(String(b.id))));
  for (const o of sorted) {
    const final = Math.max(0, o.final || 0);
    const take = Math.min(final, left);
    left -= take;
    out.set(o.id, { final, paid: take, remaining: final - take, status: payoutStatus(final, take) });
  }
  return out;
}

// The commission report for a period: earned (final) by earning date, per
// reseller, with how much of THAT period's commission has been paid
// (oldest-first). Direct sales (no reseller) never count.
//   resellers: [{ id, name, paid }]; orders: [{ id, resellerId, date, final }] (all, any date)
export function commissionReport({ resellers, orders, from, to }) {
  const rows = resellers.map((r) => {
    const mine = orders.filter((o) => o.resellerId === r.id);
    const alloc = allocatePayouts(mine, r.paid);
    const inRange = mine.filter((o) => o.date >= from && o.date <= to);
    const earned = inRange.reduce((t, o) => t + Math.max(0, o.final || 0), 0);
    const paid = inRange.reduce((t, o) => t + (alloc.get(o.id)?.paid || 0), 0);
    return { resellerId: r.id, name: r.name, orders: inRange.length, ...commissionSummary(earned, paid) };
  });
  const shown = rows.filter((r) => r.earned > 0 || r.orders > 0).sort((a, b) => b.earned - a.earned || a.name.localeCompare(b.name));
  return { from, to, total: shown.reduce((t, r) => t + r.earned, 0), rows: shown };
}
