// Luna subscription billing and platform economics (Phase 18.6).
//
// This is LUNA's own money, a platform-level domain kept apart from every
// tenant's operational finances: a Distributor's customer payments, a
// wedding's supplier payments, household salaries and baby expenses are
// never subscription payments, and Luna's platform expenses are never tenant
// Expenses. Only Luna operators see revenue, costs and margins; a tenant
// Owner sees their own plan, amount due, payment instructions, proofs and
// history (through /api/subscription, never by reading these collections).
//
// Data (all top-level, server-only; the rules deny browsers):
//   subscriptionInvoices/{businessId}_{YYYY-MM}  one per business per month:
//     plan + price SNAPSHOT (a later price change never rewrites it),
//     amountDue, amountPaid, status due | for_verification | paid
//   subscriptionPayments/{id}   a tenant's bank-transfer submission + proof
//     path, status for_verification | paid | rejected, never deleted
//   platformMetrics/{YYYY-MM}   verified revenue by verification month (cash
//     basis), by workspace and by plan; invoicesGenerated flag
//   platformMetrics/current     state counters: awaiting verification, still
//     to collect
//   platform/billingSettings    Luna's bank details, one for every workspace
//   platformExpenses/{id}       Luna's own monthly costs (Firebase, Netlify…)
//   platformCostRates/{id}      append-only, versioned cost rates
// Money is integer centavos (PHP).

export const BILLING_SCHEMA_VERSION = 1;
export const BILLING_TIMEZONE = "Asia/Manila";

export class BillingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BillingError";
    this.code = code;
  }
}

// ---------- Periods ----------

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const isPeriod = (v) => typeof v === "string" && PERIOD.test(v);
export const isDay = (v) => typeof v === "string" && DAY.test(v);
export const periodOfDay = (day) => day.slice(0, 7);
export function periodEnd(period) {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${period}-${String(last).padStart(2, "0")}`;
}
export function nextPeriod(period) {
  const [y, m] = period.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
export function previousPeriod(period) {
  const [y, m] = period.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
export function dayAfter(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
// Payment is due by the 7th of the billed month.
export const DUE_DAY = 7;
export const dueDateOf = (period) => `${period}-${String(DUE_DAY).padStart(2, "0")}`;
export const invoiceId = (businessId, period) => `${businessId}_${period}`;
// The last `n` periods ending with `period`, oldest first.
export function lastPeriods(period, n) {
  const out = [period];
  while (out.length < n) out.unshift(previousPeriod(out[0]));
  return out;
}

// ---------- Statuses ----------

export const INVOICE_STATUSES = Object.freeze({
  due: { label: "Payment Due", tone: "warning" },
  for_verification: { label: "For Verification", tone: "info" },
  paid: { label: "Paid", tone: "success" },
});
export const PAYMENT_STATUSES = Object.freeze({
  for_verification: { label: "For Verification", tone: "info" },
  paid: { label: "Paid", tone: "success" },
  rejected: { label: "Payment Rejected", tone: "danger" },
});
export const PAYMENT_STATUS_IDS = Object.freeze(Object.keys(PAYMENT_STATUSES));
// Only Bank Transfer for now (no card, GCash API or gateway).
export const SUBSCRIPTION_PAYMENT_METHODS = Object.freeze({ bank_transfer: { label: "Bank Transfer" } });
// Subscriptions that are billed and count toward MRR.
export const BILLABLE_STATUSES = Object.freeze(["active", "past_due"]);

// ---------- Validation ----------

const text = (v, { field, max, required = false }) => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new BillingError("invalid-input", `${field} is required`);
    return null;
  }
  if (typeof v !== "string") throw new BillingError("invalid-input", `${field} must be text`);
  const t = v.replace(/\s+/g, " ").trim();
  if (required && !t) throw new BillingError("invalid-input", `${field} is required`);
  if (t.length > max) throw new BillingError("invalid-input", `${field} is too long (max ${max})`);
  return t || null;
};
const MAX_AMOUNT = 100_000_000; // ₱1,000,000
const amount = (v, field = "Amount") => {
  if (!Number.isSafeInteger(v) || v <= 0 || v > MAX_AMOUNT) throw new BillingError("invalid-input", `${field} must be more than ₱0`);
  return v;
};

// Payment proof: a screenshot or a PDF receipt, at most 3 MB.
export const PROOF_TYPES = Object.freeze({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" });
export const PROOF_MAX_BYTES = 3 * 1024 * 1024;

// The tenant's submission (proof checked separately on the decoded bytes).
// Proof of payment: a screenshot / receipt OR a reference number; one is
// enough (hasProof: a file came with it). invoiceId: a specific bill (an
// upgrade bill isn't a month's bill); otherwise the month's bill.
export function validatePaymentSubmission(input, { today, hasProof = false }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BillingError("invalid-input", "Invalid payment");
  for (const k of Object.keys(input)) if (!["period", "invoiceId", "amount", "paymentDate", "reference", "method", "note"].includes(k)) throw new BillingError("invalid-input", `Field ${k} can't be set`);
  if (input.invoiceId !== undefined && (typeof input.invoiceId !== "string" || !/^[A-Za-z0-9_-]{3,120}$/.test(input.invoiceId))) throw new BillingError("invalid-input", "Choose the bill you're paying");
  if (!isPeriod(input.period)) throw new BillingError("invalid-input", "Choose the billing month you're paying");
  const method = input.method ?? "bank_transfer";
  if (!Object.hasOwn(SUBSCRIPTION_PAYMENT_METHODS, method)) throw new BillingError("invalid-input", "Choose Bank Transfer");
  if (!isDay(input.paymentDate)) throw new BillingError("invalid-input", "Choose the date you paid");
  if (input.paymentDate > today) throw new BillingError("invalid-input", "The payment date can't be in the future");
  const reference = text(input.reference, { field: "Reference number", max: 80 });
  if (!reference && !hasProof) throw new BillingError("proof-required", "Add the reference number or attach the screenshot (one is enough)");
  return {
    period: input.period,
    invoiceId: input.invoiceId ?? null,
    amount: amount(input.amount, "Amount paid"),
    paymentDate: input.paymentDate,
    method,
    reference,
    note: text(input.note, { field: "Note", max: 300 }),
  };
}

// Checks the decoded proof bytes against the declared type (magic bytes).
export function checkProof(bytes, contentType) {
  if (!Object.hasOwn(PROOF_TYPES, contentType)) throw new BillingError("invalid-proof", "Upload a JPG, PNG, WEBP image or a PDF");
  if (!bytes || !bytes.length) throw new BillingError("invalid-proof", "Upload your payment screenshot");
  if (bytes.length > PROOF_MAX_BYTES) throw new BillingError("invalid-proof", "The file is larger than 3 MB");
  const b = bytes;
  const ok =
    (contentType === "image/jpeg" && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
    (contentType === "image/png" && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||
    (contentType === "image/webp" && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) ||
    (contentType === "application/pdf" && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46);
  if (!ok) throw new BillingError("invalid-proof", "That file doesn't look like the image or PDF it says it is");
  return PROOF_TYPES[contentType];
}

export function validateRejectReason(reason) {
  const r = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : "";
  if (r.length < 3 || r.length > 300) throw new BillingError("reason-required", "Give the reason (3 to 300 characters): the business sees it");
  return r;
}

export function validateBillingSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BillingError("invalid-input", "Invalid settings");
  for (const k of Object.keys(input)) if (!["bankName", "accountName", "accountNumber", "instructions"].includes(k)) throw new BillingError("invalid-input", `Field ${k} can't be set`);
  return {
    bankName: text(input.bankName, { field: "Bank name", max: 80, required: true }),
    accountName: text(input.accountName, { field: "Account name", max: 100, required: true }),
    accountNumber: text(input.accountNumber, { field: "Account number", max: 40, required: true }),
    instructions: text(input.instructions, { field: "Instructions", max: 500 }),
  };
}

// ---------- Luna's own platform expenses ----------

// infra: part of the actual infrastructure bill (compared with the
// usage-based estimate). Every platform expense is SHARED (Luna pays it
// whatever one tenant does); none is allocated to a tenant.
export const PLATFORM_EXPENSE_CATEGORIES = Object.freeze({
  firebase_gcp: { label: "Firebase / Google Cloud", infra: true },
  netlify: { label: "Netlify", infra: true },
  resend: { label: "Resend (email)", infra: false },
  domain_dns: { label: "Domain / DNS", infra: false },
  other_saas: { label: "Other software", infra: false },
  other: { label: "Other", infra: false },
});
export const PLATFORM_EXPENSE_CATEGORY_IDS = Object.freeze(Object.keys(PLATFORM_EXPENSE_CATEGORIES));
export const PLATFORM_EXPENSE_KINDS = Object.freeze({ recurring: { label: "Recurring monthly" }, one_time: { label: "One-time" } });

export function validatePlatformExpense(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BillingError("invalid-input", "Invalid expense");
  for (const k of Object.keys(input)) if (!["month", "category", "description", "amount", "kind", "notes", "reference"].includes(k)) throw new BillingError("invalid-input", `Field ${k} can't be set`);
  const has = (k) => !partial || Object.hasOwn(input, k);
  const out = {};
  if (has("month")) {
    if (!isPeriod(input.month)) throw new BillingError("invalid-input", "Choose the billing month");
    out.month = input.month;
  }
  if (has("category")) {
    if (!PLATFORM_EXPENSE_CATEGORY_IDS.includes(input.category)) throw new BillingError("invalid-input", "Choose a category");
    out.category = input.category;
  }
  if (has("description")) out.description = text(input.description, { field: "Description", max: 120, required: true });
  if (has("amount")) out.amount = amount(input.amount);
  if (has("kind")) {
    if (!Object.hasOwn(PLATFORM_EXPENSE_KINDS, input.kind)) throw new BillingError("invalid-input", "Choose recurring or one-time");
    out.kind = input.kind;
  }
  if (has("notes")) out.notes = text(input.notes, { field: "Notes", max: 300 });
  if (has("reference")) out.reference = text(input.reference, { field: "Invoice / reference", max: 80 });
  if (partial && !Object.keys(out).length) throw new BillingError("invalid-input", "Nothing to change");
  return out;
}

// ---------- Cost rate card ----------

// measured: Luna meters it per tenant today. Unmeasured resources are
// listed so a rate can be kept, but their per-tenant cost shows as
// "Unavailable": an order or a page view is NOT turned into a guessed
// Firestore cost.
export const COST_RESOURCES = Object.freeze({
  storage_gb_month: { label: "Storage retained", unit: "GB-month", provider: "firebase_gcp", measured: true },
  export_download_gb: { label: "Excel downloads (bandwidth)", unit: "GB", provider: "netlify", measured: true },
  firestore_reads: { label: "Database reads", unit: "100,000 reads", provider: "firebase_gcp", measured: false },
  firestore_writes: { label: "Database writes", unit: "100,000 writes", provider: "firebase_gcp", measured: false },
  firestore_deletes: { label: "Database deletes", unit: "100,000 deletes", provider: "firebase_gcp", measured: false },
  function_invocations: { label: "Server functions", unit: "1,000,000 invocations", provider: "netlify", measured: false },
});
export const COST_RESOURCE_IDS = Object.freeze(Object.keys(COST_RESOURCES));

// A rate version: ratePerUnit is centavos per unit (decimals allowed, e.g.
// 0.35); freeAllowance is a platform-wide monthly allowance in units (never
// handed to a single tenant: the per-tenant estimate ignores it).
export function validateCostRate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BillingError("invalid-input", "Invalid rate");
  for (const k of Object.keys(input)) if (!["resource", "ratePerUnit", "currency", "effectiveFrom", "freeAllowance", "note"].includes(k)) throw new BillingError("invalid-input", `Field ${k} can't be set`);
  if (!COST_RESOURCE_IDS.includes(input.resource)) throw new BillingError("invalid-input", "Choose a resource");
  if (typeof input.ratePerUnit !== "number" || !Number.isFinite(input.ratePerUnit) || input.ratePerUnit < 0 || input.ratePerUnit > 10_000_000) throw new BillingError("invalid-input", "Enter a rate of ₱0 or more");
  if ((input.currency ?? "PHP") !== "PHP") throw new BillingError("invalid-input", "Rates are kept in PHP");
  if (!isDay(input.effectiveFrom)) throw new BillingError("invalid-input", "Choose the date the rate takes effect");
  const free = input.freeAllowance ?? 0;
  if (typeof free !== "number" || !Number.isFinite(free) || free < 0) throw new BillingError("invalid-input", "The free allowance must be 0 or more");
  const r = COST_RESOURCES[input.resource];
  return { resource: input.resource, provider: r.provider, unit: r.unit, ratePerUnit: Math.round(input.ratePerUnit * 10000) / 10000, currency: "PHP", effectiveFrom: input.effectiveFrom, freeAllowance: free, note: text(input.note, { field: "Note", max: 200 }) };
}

// The rate in effect for a month: the latest version whose effectiveFrom is
// on or before the month's first day. Versions are never edited, so an
// older month keeps its rate when a new one is added.
export function rateFor(rates, resource, period) {
  const first = `${period}-01`;
  return (rates || []).filter((r) => r.resource === resource && r.effectiveFrom <= first).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0))[0] ?? null;
}

const GB = 1024 ** 3;
// Estimated platform usage cost for one tenant-month, from MEASURED usage
// only. Each line: { resource, label, measured, quantity, unit, cost }.
// cost is null when the resource isn't measured or has no rate yet.
export function estimateUsageCost({ storageBytes = 0, exportBytes = null } = {}, rates, period) {
  const lines = COST_RESOURCE_IDS.map((resource) => {
    const def = COST_RESOURCES[resource];
    let quantity = null;
    if (resource === "storage_gb_month") quantity = Math.max(0, storageBytes || 0) / GB;
    if (resource === "export_download_gb" && exportBytes !== null) quantity = Math.max(0, exportBytes) / GB;
    const rate = def.measured ? rateFor(rates, resource, period) : null;
    const cost = quantity === null || !rate ? null : Math.round(quantity * rate.ratePerUnit);
    return { resource, label: def.label, measured: def.measured && quantity !== null, quantity, unit: def.unit, rate: rate?.ratePerUnit ?? null, cost };
  });
  const known = lines.filter((l) => l.cost !== null);
  return { lines, total: known.reduce((s, l) => s + l.cost, 0), complete: known.length === lines.length };
}

// ---------- Profit ----------

// Estimated Platform Gross Profit = verified subscription revenue − the
// platform expenses entered for the month. NOT net profit: owner pay, sales
// commissions, tax, marketing, professional fees and other overhead aren't
// in it.
export const grossProfit = (revenue, costs) => (revenue || 0) - (costs || 0);
export const grossMarginPct = (gp, revenue) => (revenue > 0 ? Math.round((gp / revenue) * 1000) / 10 : null);
export const PROFIT_HELP = "Estimated Platform Gross Profit = verified Luna subscription payments collected in the month − the platform expenses recorded for that month (Firebase / Google Cloud, Netlify, email, domains, other software). It is not net profit: owner pay, sales commissions, taxes, marketing, professional fees and other company overhead are not included.";

// What a bill is FOR (2026-10-28), from the bill itself, never from the
// amount (₱499 is both Luna Bridal — 3 Months and the Premium wedding link):
//   { kind: "access" | "addon" | "upgrade" | "monthly", label, months, does }
// does: what confirming its payment in full changes: "activate" (access for
// its months), "unlock" (the add-on), "upgrade", or "credit" (the month).
export function billProduct(inv) {
  const i = inv && typeof inv === "object" ? inv : {};
  const plan = i.planName || i.planId || "Luna";
  if (i.kind === "addon") {
    const line = (Array.isArray(i.lines) ? i.lines : []).find((l) => l.kind === "addon");
    return { kind: "addon", label: `${line?.label || "Add-on"} add-on`, months: 0, addOnId: line?.addOnId ?? null, does: "unlock" };
  }
  if (i.kind === "upgrade") return { kind: "upgrade", label: `Upgrade to ${plan}`, months: 0, does: "upgrade" };
  const months = Number.isSafeInteger(i.months) && i.months > 0 ? i.months : 1;
  if (i.billingType === "term" || i.billingType === "annual") return { kind: "access", label: `${plan} — ${months} Month${months === 1 ? "" : "s"}`, months, does: "activate" };
  return { kind: "monthly", label: `${plan} — monthly`, months, does: "credit" };
}
