// Super Admin: plan pricing and limits are edited here, not in code
// (2026-10-19). plans/{planId} is the source of truth (shared/plans.seed.js
// only seeds it). An edit applies to NEW businesses and to plan changes:
// an existing business keeps the price snapshot and limits it was given
// until an operator changes or re-applies its plan (nothing is rewritten
// behind a customer's back).

import { validatePlan } from "../../../shared/entitlements.js";
import { BILLING_TYPE_IDS, planBilling } from "../../../shared/plan-billing.js";
import { ProvisioningError } from "./provisioning.js";

const TX = { maxAttempts: 10 };
const MAX_PRICE = 100_000_000; // ₱1,000,000
const MB = 1024 * 1024;
const FIELDS = ["name", "billingType", "price", "priceIsMinimum", "setupFee", "termMonths", "users", "storageMb", "foundingPrice"];

const money = (v, label, { allowZero = true } = {}) => {
  if (!Number.isSafeInteger(v) || v < (allowZero ? 0 : 1) || v > MAX_PRICE) throw new ProvisioningError("invalid-input", `${label}: enter an amount in pesos`);
  return v;
};

export function applyPlanEdit(plan, changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new ProvisioningError("invalid-input", "Nothing to change");
  for (const k of Object.keys(changes)) if (!FIELDS.includes(k)) throw new ProvisioningError("invalid-input", `${k} can't be changed here`);
  const next = structuredClone(plan);
  const b = planBilling(plan);
  const pricing = { ...next.pricing };
  if ("name" in changes) {
    const n = typeof changes.name === "string" ? changes.name.trim().replace(/\s+/g, " ") : "";
    if (n.length < 2 || n.length > 60) throw new ProvisioningError("invalid-input", "Plan name: 2 to 60 characters");
    next.name = n;
  }
  const type = "billingType" in changes ? changes.billingType : b.type;
  if (!BILLING_TYPE_IDS.includes(type)) throw new ProvisioningError("invalid-input", "Choose monthly, annual or 12-month access");
  const price = "price" in changes ? money(changes.price, "Price", { allowZero: false }) : b.price;
  pricing.billingType = type;
  pricing.price = price;
  pricing.priceIsMinimum = "priceIsMinimum" in changes ? changes.priceIsMinimum === true : b.priceIsMinimum;
  pricing.setupFee = "setupFee" in changes ? money(changes.setupFee, "Setup fee") : b.setupFee;
  pricing.termMonths = type === "monthly" ? 1 : "termMonths" in changes ? changes.termMonths : b.type === "monthly" ? 12 : b.termMonths;
  if (!Number.isSafeInteger(pricing.termMonths) || pricing.termMonths < 1 || pricing.termMonths > 36) throw new ProvisioningError("invalid-input", "Access duration: 1 to 36 months");
  pricing.autoRenew = type !== "term";
  // The recurring monthly price (MRR) only for monthly plans.
  pricing.monthly = type === "monthly" ? price : 0;
  pricing.monthlyIsMinimum = type === "monthly" ? pricing.priceIsMinimum : false;
  if ("foundingPrice" in changes) {
    if (changes.foundingPrice === null) pricing.founding = null;
    else pricing.founding = { ...(b.founding || { months: 12, label: null }), price: money(changes.foundingPrice, "Founding price", { allowZero: false }) };
  }
  next.pricing = pricing;
  const limits = { ...next.limits };
  if ("users" in changes) {
    if (!Number.isSafeInteger(changes.users) || changes.users < 1 || changes.users > 1000) throw new ProvisioningError("invalid-input", "Users: 1 to 1,000");
    limits.users = changes.users;
  }
  if ("storageMb" in changes) {
    if (!Number.isSafeInteger(changes.storageMb) || changes.storageMb < 1 || changes.storageMb > 1024 * 1024) throw new ProvisioningError("invalid-input", "Storage: a whole number of MB");
    limits.storageBytes = changes.storageMb * MB;
  }
  next.limits = limits;
  try {
    validatePlan(next);
  } catch (err) {
    throw new ProvisioningError("invalid-input", err.message);
  }
  return next;
}

export async function savePlan({ db, FieldValue, planId, changes, operator }) {
  if (typeof planId !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(planId)) throw new ProvisioningError("unknown-plan", "Unknown plan.");
  const ref = db.collection("plans").doc(planId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ProvisioningError("unknown-plan", "Unknown plan.");
    const before = snap.data();
    const next = applyPlanEdit(before, changes);
    const stamp = FieldValue.serverTimestamp();
    tx.set(ref, { ...next, updatedAt: stamp, updatedBy: operator });
    tx.set(db.collection("platformAudit").doc(), { type: "plan.changed", summary: `Plan ${next.name} changed`, planId, actor: operator, before: { name: before.name, pricing: before.pricing, limits: before.limits }, after: { name: next.name, pricing: next.pricing, limits: next.limits }, at: stamp });
    return { plan: { ...next, updatedAt: null } };
  }, TX);
}
