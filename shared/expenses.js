// Expenses (Phase 10): a simple operating-expense tracker, not an
// accounting system (no payables, ledger, chart of accounts, tax or
// recurring generation).
//
// Record: businesses/{bid}/expenses/{expenseId}
//   date        business-local YYYY-MM-DD the expense counts on
//   category    a category id below (ids are stable; labels may change)
//   amount      integer centavos, > 0
//   payee       vendor / payee (optional)
//   method      one of EXPENSE_METHODS
//   reference   optional (OR no., invoice no., transfer ref); no uniqueness
//               rule: an expense is not an order payment
//   notes       optional
//   recurring   true/false flag only (Luna doesn't generate repeats)
//   status      active | removed (removal keeps the record for audit)
//   history[], revision, createdBy/At, updatedBy/At
//
// Recognition depends on the workspace (EXPENSE_PROFILES, Phase 15): the
// record behaviour above is shared; what an expense COUNTS AS is not.
//   distributor   an Operating Expense on its business-local date
//                 (financialMetrics/{date} and its month, + the report
//                 rollups), from a fixed category list.
//   baby-expense  Baby spending against the budget (budgets/current and
//                 spendingMetrics/{date|month}, shared/baby.js), from the
//                 tenant's own categories, optionally paid to a saved
//                 provider (providerId; payee holds the provider's name
//                 snapshot). Never sales, COGS or profit.
// The server keeps those totals in step on create / edit / remove; the
// browser never writes them.

import { isDayId } from "./metrics.js";
import { isCentavos } from "./quantity.js";
import { isValidRecordId } from "./baby.js";

export const EXPENSE_SCHEMA_VERSION = 1;

// Starting categories. A tenant-defined list can be added later (same
// stable-id rule) without migrating records.
export const DEFAULT_EXPENSE_CATEGORIES = Object.freeze([
  { id: "rent", label: "Rent" },
  { id: "utilities", label: "Utilities" },
  { id: "delivery", label: "Transportation / Delivery" },
  { id: "salaries", label: "Salaries / Labor" },
  { id: "marketing", label: "Marketing / Advertising" },
  { id: "supplies", label: "Supplies" },
  { id: "packaging", label: "Packaging" },
  { id: "repairs", label: "Repairs / Maintenance" },
  { id: "fees", label: "Fees" },
  { id: "misc", label: "Miscellaneous" },
]);
export const EXPENSE_CATEGORY_IDS = Object.freeze(DEFAULT_EXPENSE_CATEGORIES.map((c) => c.id));
export const expenseCategoryLabel = (id) => DEFAULT_EXPENSE_CATEGORIES.find((c) => c.id === id)?.label ?? id;

export const EXPENSE_METHODS = Object.freeze({
  cash: { label: "Cash" },
  gcash: { label: "GCash" },
  maya: { label: "Maya" },
  bank_transfer: { label: "Bank Transfer" },
  card: { label: "Card" },
  other: { label: "Other" },
});
export const EXPENSE_METHOD_IDS = Object.freeze(Object.keys(EXPENSE_METHODS));
// Kept for Phase 5 references.
export const EXPENSE_PAYMENT_METHODS = EXPENSE_METHOD_IDS;

export const EXPENSE_STATUSES = Object.freeze({ active: { label: "Active" }, removed: { label: "Removed" } });

export const EXPENSE_FIELDS = Object.freeze(["date", "category", "amount", "payee", "method", "reference", "notes", "recurring"]);

// Per-workspace expense behaviour (Phase 15). Data only: the server pairs
// each profile with its own totals ("sink"); unknown workspaces have none,
// so expenses can't be recorded there.
//   categories  "fixed"  = DEFAULT_EXPENSE_CATEGORIES ids
//               "tenant" = the business's own expenseCategories doc ids
//   ref         an optional saved payee the browser may choose (its name
//               becomes the payee snapshot): Baby provider, Wedding supplier
//   link        the server-set provenance field: the scheduled / supplier
//               payment an expense was recorded from (never sent by the browser)
export const EXPENSE_PROFILES = Object.freeze({
  distributor: Object.freeze({ id: "distributor", categories: "fixed", fields: EXPENSE_FIELDS, ref: null, link: null }),
  "baby-expense": Object.freeze({ id: "baby-expense", categories: "tenant", fields: Object.freeze([...EXPENSE_FIELDS, "providerId"]), ref: "providerId", refLabel: "provider", link: "scheduleId" }),
  // Phase 16: Wedding Expenses.
  "bridal-expense": Object.freeze({ id: "bridal-expense", categories: "tenant", fields: Object.freeze([...EXPENSE_FIELDS, "supplierId"]), ref: "supplierId", refLabel: "supplier", link: "supplierPaymentId" }),
});
export const expenseProfile = (workspaceTemplateId) => (typeof workspaceTemplateId === "string" && Object.hasOwn(EXPENSE_PROFILES, workspaceTemplateId) ? EXPENSE_PROFILES[workspaceTemplateId] : null);

// One expense can't exceed ₱100,000,000 (a typo guard, not a business rule).
export const MAX_EXPENSE_CENTAVOS = 10_000_000_000;

export class ExpenseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function text(value, { field, max }) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ExpenseError("invalid-input", `${field} must be text`);
  const t = value.trim().replace(/\s+/g, " ");
  if (t.length > max) throw new ExpenseError("invalid-input", `${field} is too long (max ${max})`);
  return t || null;
}

// Full validation for a new expense; `partial` for an edit (only the keys
// present change). `today` is the business-local date: future dates are
// refused (an expense is recorded when it happened; money still to be paid
// belongs in the Baby Payment Schedule). `profile` (EXPENSE_PROFILES) sets
// the category rule and extra fields; the server always passes the
// workspace's profile, and without one this is the original Phase 10
// (fixed-category) validation.
export function validateExpenseInput(input, { partial = false, today, profile = EXPENSE_PROFILES.distributor } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ExpenseError("invalid-input", "Invalid expense");
  for (const key of Object.keys(input)) if (!profile.fields.includes(key)) throw new ExpenseError("invalid-input", `Field ${key} can't be set here`);
  const has = (k) => !partial || Object.hasOwn(input, k);
  const out = {};
  if (has("date")) {
    if (!isDayId(input.date)) throw new ExpenseError("invalid-input", "Choose a valid date");
    if (today && input.date > today) throw new ExpenseError("invalid-input", "An expense can't be dated in the future");
    out.date = input.date;
  }
  if (has("category")) {
    const ok = profile.categories === "tenant" ? isValidRecordId(input.category) : EXPENSE_CATEGORY_IDS.includes(input.category);
    if (!ok) throw new ExpenseError("invalid-input", "Choose a category");
    out.category = input.category;
  }
  if (profile.ref && has(profile.ref)) {
    const v = input[profile.ref];
    if (v !== null && v !== undefined && !isValidRecordId(v)) throw new ExpenseError("invalid-input", `Choose a ${profile.refLabel}`);
    out[profile.ref] = v ?? null;
  }
  if (has("amount")) {
    if (!isCentavos(input.amount) || input.amount <= 0) throw new ExpenseError("invalid-amount", "Amount must be more than ₱0");
    if (input.amount > MAX_EXPENSE_CENTAVOS) throw new ExpenseError("invalid-amount", "That amount is too large for one expense");
    out.amount = input.amount;
  }
  if (has("payee")) out.payee = text(input.payee, { field: "Vendor / payee", max: 120 });
  if (has("method")) {
    if (!EXPENSE_METHOD_IDS.includes(input.method)) throw new ExpenseError("invalid-input", "Choose a payment method");
    out.method = input.method;
  }
  if (has("reference")) out.reference = text(input.reference, { field: "Reference", max: 60 });
  if (has("notes")) out.notes = text(input.notes, { field: "Notes", max: 500 });
  if (has("recurring")) {
    if (input.recurring !== undefined && typeof input.recurring !== "boolean") throw new ExpenseError("invalid-input", "Recurring must be yes or no");
    out.recurring = input.recurring === true;
  }
  if (partial && !Object.keys(out).length) throw new ExpenseError("invalid-input", "Nothing to change");
  return out;
}
