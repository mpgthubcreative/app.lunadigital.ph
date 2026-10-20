// Super Admin: product pricing and limits are edited here, not in code
// (2026-10-19; terms and add-ons 2026-10-20). plans/{planId} is the source of
// truth (shared/plans.seed.js only seeds it). An edit applies to NEW
// businesses and product / access changes: an existing business keeps the
// price snapshot, term and limits it was given until an operator changes
// them (nothing is rewritten behind a customer's back).
//
// What can change: name, tagline, setup fee, "starting at", included users
// and storage, each term's price (the main term's price is the product's
// price) and each add-on's price. A product's billing type, its term
// lengths and its add-on list are part of how it's sold and stay as seeded.

import { validatePlan } from "../../../shared/entitlements.js";
import { planBilling } from "../../../shared/plan-billing.js";
import { ProvisioningError } from "./provisioning.js";

const TX = { maxAttempts: 10 };
const MAX_PRICE = 100_000_000; // ₱1,000,000
const MB = 1024 * 1024;
const FIELDS = ["name", "tagline", "priceIsMinimum", "setupFee", "users", "storageMb", "termPrices", "addOnPrices"];

const money = (v, label, { allowZero = true } = {}) => {
  if (!Number.isSafeInteger(v) || v < (allowZero ? 0 : 1) || v > MAX_PRICE) throw new ProvisioningError("invalid-input", `${label}: enter an amount in pesos`);
  return v;
};
const obj = (v, label) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ProvisioningError("invalid-input", `${label}: invalid`);
  return v;
};

export function applyPlanEdit(plan, changes) {
  obj(changes, "Changes");
  if (!Object.keys(changes).length) throw new ProvisioningError("invalid-input", "Nothing to change");
  for (const k of Object.keys(changes)) if (!FIELDS.includes(k)) throw new ProvisioningError("invalid-input", `${k} can't be changed here`);
  const next = structuredClone(plan);
  const b = planBilling(plan);
  const pricing = { ...next.pricing, billingType: b.type, termMonths: b.termMonths, terms: b.terms.map((t) => ({ months: t.months, price: t.price, kind: t.kind, ...(t.label ? { label: t.label } : {}) })), addOns: b.addOns.map((a) => ({ ...a })) };
  if ("name" in changes) {
    const n = typeof changes.name === "string" ? changes.name.trim().replace(/\s+/g, " ") : "";
    if (n.length < 2 || n.length > 60) throw new ProvisioningError("invalid-input", "Product name: 2 to 60 characters");
    next.name = n;
  }
  if ("tagline" in changes) {
    const t = typeof changes.tagline === "string" ? changes.tagline.trim().replace(/\s+/g, " ") : "";
    if (t.length > 160) throw new ProvisioningError("invalid-input", "Tagline: up to 160 characters");
    if (t) next.tagline = t;
    else delete next.tagline;
  }
  if ("termPrices" in changes) {
    for (const [months, price] of Object.entries(obj(changes.termPrices, "Term prices"))) {
      const t = pricing.terms.find((x) => String(x.months) === months);
      if (!t) throw new ProvisioningError("invalid-input", `${next.name} isn't sold for ${months} months`);
      t.price = money(price, `${months}-month price`, { allowZero: false });
    }
  }
  if ("addOnPrices" in changes) {
    for (const [id, price] of Object.entries(obj(changes.addOnPrices, "Add-on prices"))) {
      const a = pricing.addOns.find((x) => x.id === id);
      if (!a) throw new ProvisioningError("invalid-input", `${next.name} has no add-on ${id}`);
      a.price = money(price, a.label, { allowZero: false });
    }
  }
  // The product's price = its main term's price (monthly: the month).
  const main = pricing.terms.find((t) => t.months === (b.type === "monthly" ? 1 : b.defaultTermMonths)) ?? pricing.terms[0];
  pricing.price = main.price;
  pricing.priceIsMinimum = "priceIsMinimum" in changes ? changes.priceIsMinimum === true : b.priceIsMinimum;
  pricing.setupFee = "setupFee" in changes ? money(changes.setupFee, "Setup fee") : b.setupFee;
  // The recurring monthly price (MRR) only for monthly products.
  pricing.monthly = b.type === "monthly" ? main.price : 0;
  pricing.monthlyIsMinimum = b.type === "monthly" ? pricing.priceIsMinimum : false;
  delete pricing.founding;
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
    tx.set(db.collection("platformAudit").doc(), { type: "plan.changed", summary: `Product ${next.name} changed`, planId, actor: operator, before: { name: before.name, pricing: before.pricing, limits: before.limits }, after: { name: next.name, pricing: next.pricing, limits: next.limits }, at: stamp });
    return { plan: { ...next, updatedAt: null } };
  }, TX);
}
