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
// Recognition: the amount is an Operating Expense on its business-local
// date (financialMetrics/{date} and its month). The server keeps those
// metrics in step on create / edit / remove; the browser never writes
// them. The record has no template-specific fields: other workspaces may
// reuse this domain later under their own label ("Wedding Expenses").

import { isDayId } from "./metrics.js";
import { isCentavos } from "./quantity.js";

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
// refused (an expense is recorded when it happened).
export function validateExpenseInput(input, { partial = false, today } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ExpenseError("invalid-input", "Invalid expense");
  for (const key of Object.keys(input)) if (!EXPENSE_FIELDS.includes(key)) throw new ExpenseError("invalid-input", `Field ${key} can't be set here`);
  const has = (k) => !partial || Object.hasOwn(input, k);
  const out = {};
  if (has("date")) {
    if (!isDayId(input.date)) throw new ExpenseError("invalid-input", "Choose a valid date");
    if (today && input.date > today) throw new ExpenseError("invalid-input", "An expense can't be dated in the future");
    out.date = input.date;
  }
  if (has("category")) {
    if (!EXPENSE_CATEGORY_IDS.includes(input.category)) throw new ExpenseError("invalid-input", "Choose a category");
    out.category = input.category;
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
