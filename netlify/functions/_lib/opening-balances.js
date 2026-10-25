// Opening balances (2026-10-25, Distributor setup): what a customer ALREADY
// owed when Luna became the source of truth (the cutover date).
//
//   openingBalances/{id}  { customerId, customerName, amount, paid, balance,
//                           effectiveDay, note, source, status, history }   server-only
//
// An opening balance only says "this customer owed ₱X at the cutover". It
// adds to the customer's balance (stats.outstandingBalance) and to the
// business's receivables (financialMetrics/current.receivablesOutstanding),
// nothing else: it is not an order or a sale (no order count, revenue,
// COGS, stock, fulfilment or sales notification) and never enters the
// day's sales or payments figures. Collected later with payOpeningBalance;
// a migration mistake is voided (with a reason, kept in its history) only
// while nothing has been collected. Every write is keyed, so a retried
// request changes the balance once.

import { createHash } from "node:crypto";
import { applyCustomerStats } from "./customers.js";
import { adjustCurrentMetrics } from "./metrics.js";
import { isValidCustomerId } from "../../../shared/customers.js";
import { isValidIdempotencyKey } from "../../../shared/orders.js";
import { isDayId } from "../../../shared/metrics.js";
import { PAYMENT_METHODS } from "../../../shared/payments.js";
import { MAX_CENTAVOS } from "../../../shared/quantity.js";

const TX_OPTIONS = { maxAttempts: 10 };
const MAX_HISTORY = 200;
const MAX_KEYS = 200;

export class OpeningBalanceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new OpeningBalanceError(code, message);
};
const hash = (v) => createHash("sha256").update(String(v)).digest("hex");
export const openingBalanceIdFor = (key) => `ob${hash(key).slice(0, 30)}`;
const amountOf = (v, label = "Amount") => (Number.isSafeInteger(v) && v >= 1 && v <= MAX_CENTAVOS ? v : fail("invalid-amount", `${label}: enter an amount more than ₱0`));
const text = (v, max, label) => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") fail("invalid-input", `${label} must be text`);
  const t = v.trim().replace(/\s+/g, " ");
  if (t.length > max) fail("invalid-input", `${label}: up to ${max} characters`);
  return t || null;
};
const key = (k) => (isValidIdempotencyKey(k) ? k : fail("invalid-input", "A valid request key is required"));
const append = (list, e) => {
  const l = Array.isArray(list) ? list : [];
  if (l.length >= MAX_HISTORY) fail("history-full", "Too many changes on this record");
  return [...l, e];
};
const who = (a) => (a ? { uid: a.uid ?? null, name: a.name ?? null } : null);

// A customer's opening balance at the cutover. source: "setup_import" | "manual".
export async function createOpeningBalance({ db, tenant, FieldValue, customerId, amount, effectiveDay, note = null, source = "manual", actor, idempotencyKey }) {
  if (!isValidCustomerId(customerId)) fail("invalid-customer", "Choose a customer");
  amountOf(amount, "Opening balance");
  if (!isDayId(effectiveDay)) fail("invalid-input", "Choose the cutover date");
  const cleanNote = text(note, 200, "Note");
  const ref = tenant.doc("openingBalances", openingBalanceIdFor(key(idempotencyKey)));
  const cRef = tenant.doc("customers", customerId);
  return db.runTransaction(async (tx) => {
    const [prior, c] = [await tx.get(ref), await tx.get(cRef)];
    if (prior.exists) {
      const p = prior.data();
      if (p.customerId !== customerId || p.amount !== amount || p.effectiveDay !== effectiveDay) fail("idempotency-conflict", "This request was already used for a different opening balance");
      return { openingBalanceId: ref.id, replayed: true };
    }
    if (!c.exists) fail("not-found", "Customer not found");
    const stamp = FieldValue.serverTimestamp();
    tx.create(ref, {
      schemaVersion: 1,
      customerId,
      customerName: c.data().name,
      amount,
      paid: 0,
      balance: amount,
      effectiveDay,
      note: cleanNote,
      source: source === "setup_import" ? "setup_import" : "manual",
      status: "open",
      payKeys: [],
      history: [{ type: "created", at: new Date(), actor: who(actor), amount, effectiveDay }],
      createdBy: who(actor),
      createdAt: stamp,
      updatedAt: stamp,
    });
    applyCustomerStats(tx, { tenant, FieldValue, customerId, balance: amount });
    adjustCurrentMetrics({ tx, tenant, FieldValue, financial: { receivablesOutstanding: amount } });
    return { openingBalanceId: ref.id, balance: amount };
  }, TX_OPTIONS);
}

// Money collected on an opening balance (cash / GCash / bank …). The same
// request again (its key) is recorded once.
export async function payOpeningBalance({ db, tenant, FieldValue, openingBalanceId, amount, method, reference = null, note = null, actor, idempotencyKey, now = new Date() }) {
  amountOf(amount);
  if (!Object.hasOwn(PAYMENT_METHODS, method)) fail("invalid-input", "Choose how it was paid");
  const k = key(idempotencyKey);
  const ref = tenant.doc("openingBalances", typeof openingBalanceId === "string" && /^ob[a-f0-9]{30}$/.test(openingBalanceId) ? openingBalanceId : fail("not-found", "Opening balance not found"));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail("not-found", "Opening balance not found");
    const b = snap.data();
    if ((b.payKeys || []).includes(k)) return { openingBalanceId: ref.id, balance: b.balance, alreadyRecorded: true };
    if (b.status === "voided") fail("voided", "This opening balance was voided");
    if (amount > b.balance) fail("overpayment", `That's more than what's left (₱${(b.balance / 100).toLocaleString("en-PH")})`);
    if ((b.payKeys || []).length >= MAX_KEYS) fail("history-full", "Too many payments on this record");
    const balance = b.balance - amount;
    tx.update(ref, {
      paid: b.paid + amount,
      balance,
      status: balance === 0 ? "settled" : "open",
      payKeys: [...(b.payKeys || []), k],
      history: append(b.history, { type: "payment", at: now, actor: who(actor), amount, method, reference: text(reference, 80, "Reference"), note: text(note, 200, "Note") }),
      updatedAt: FieldValue.serverTimestamp(),
    });
    applyCustomerStats(tx, { tenant, FieldValue, customerId: b.customerId, balance: -amount });
    adjustCurrentMetrics({ tx, tenant, FieldValue, financial: { receivablesOutstanding: -amount } });
    return { openingBalanceId: ref.id, balance, paid: b.paid + amount };
  }, TX_OPTIONS);
}

// A migration mistake: voided with a reason, before anything was collected.
// Kept (status "voided", history) — never deleted.
export async function voidOpeningBalance({ db, tenant, FieldValue, openingBalanceId, reason, actor }) {
  const why = text(reason, 300, "Reason");
  if (!why || why.length < 3) fail("reason-required", "Say why this opening balance is being voided (3-300 characters)");
  const ref = tenant.doc("openingBalances", typeof openingBalanceId === "string" && /^ob[a-f0-9]{30}$/.test(openingBalanceId) ? openingBalanceId : fail("not-found", "Opening balance not found"));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail("not-found", "Opening balance not found");
    const b = snap.data();
    if (b.status === "voided") fail("voided", "This opening balance is already voided");
    if (b.paid > 0) fail("has-payments", "Payments were already collected on this opening balance; it can't be voided");
    tx.update(ref, { status: "voided", balance: 0, history: append(b.history, { type: "voided", at: new Date(), actor: who(actor), reason: why, amount: b.balance }), updatedAt: FieldValue.serverTimestamp() });
    applyCustomerStats(tx, { tenant, FieldValue, customerId: b.customerId, balance: -b.balance });
    adjustCurrentMetrics({ tx, tenant, FieldValue, financial: { receivablesOutstanding: -b.balance } });
    return { openingBalanceId: ref.id, voided: true };
  }, TX_OPTIONS);
}
