// Baby Expense Tracker (Phase 15): the shared vocabulary, validation and the
// budget arithmetic. A personal budget / spending tracker for preparing for
// and caring for a baby: not accounting, not a medical record. Server and
// UI use the same functions; only the server writes.
//
// Records (businesses/{bid}/...):
//   expenseCategories/{id}   tenant categories = the budget lines: name,
//                            status (active | inactive), optional budget
//                            allocation, order, useCount (references ever
//                            made; a category can be deleted only while 0)
//   budgets/current          the overall budget and Luna's running totals:
//                            total (the user's budget), spent / expenseCount /
//                            spentByCategory (active Baby Expenses),
//                            upcoming / upcomingCount / upcomingByCategory
//                            (Upcoming scheduled payments), threshold alerts,
//                            budget-change history
//   spendingMetrics/{day|month}  spent / count / byCategory per business-
//                            local day and month (the Dashboard's selected
//                            period, summed like every other period metric)
//   providers/{id}           a small directory of clinics, shops and services
//   scheduledPayments/{id}   money expected to be paid later: Upcoming ->
//                            Paid (exactly one linked Baby Expense) or
//                            Cancelled
//   expenses/{id}            the Expenses Core record (shared/expenses.js),
//                            with the Baby profile's category snapshot and
//                            optional providerId
//
// Luna computes Spent from the recorded expenses; nobody types it, and the
// browser never sends a total.
//   Remaining          = Budget - Spent (active expenses)
//   Category remaining = Category budget - Category spent
// An Upcoming payment is committed money, not spending: it counts in
// Upcoming until it's marked Paid, when it becomes ONE expense.

import { isDayId } from "./metrics.js";
import { isCentavos } from "./quantity.js";

export const BABY_SCHEMA_VERSION = 1;
export const BUDGET_DOC_ID = "current";

export class BabyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const RECORD_ID = /^[A-Za-z0-9]{8,40}$/;
export const isValidRecordId = (v) => typeof v === "string" && RECORD_ID.test(v);

// Typo guards, not business rules.
export const MAX_BUDGET_CENTAVOS = 100_000_000_000; // ₱1,000,000,000
export const MAX_PAYMENT_CENTAVOS = 10_000_000_000; // ₱100,000,000 (same as one expense)
export const MAX_CATEGORIES = 50;

// ---------- Categories (the budget lines) ----------

export const CATEGORY_STATUSES = Object.freeze({ active: { label: "Active" }, inactive: { label: "Inactive" } });

// Offered once, on an empty workspace ("Add suggested categories"). Tenant
// data from then on: renamed, reordered, deactivated like any other.
export const SUGGESTED_CATEGORIES = Object.freeze(["Medical", "Nursery / Furniture", "Clothing", "Feeding", "Diapers / Hygiene", "Gear / Equipment", "Transportation", "Documents", "Celebration", "Childcare", "Other"]);

function text(value, { field, max, required = false }) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new BabyError("invalid-input", `${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new BabyError("invalid-input", `${field} must be text`);
  const t = value.trim().replace(/\s+/g, " ");
  if (t.length > max) throw new BabyError("invalid-input", `${field} is too long (max ${max})`);
  if (!t && required) throw new BabyError("invalid-input", `${field} is required`);
  return t || null;
}

function only(input, fields, what) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BabyError("invalid-input", `Invalid ${what}`);
  for (const k of Object.keys(input)) if (!fields.includes(k)) throw new BabyError("invalid-input", `Field ${k} can't be set here`);
}

// A budget amount: integer centavos >= 0, or null (= no budget set).
function budgetAmount(value, field) {
  if (value === null) return null;
  if (!isCentavos(value) || value > MAX_BUDGET_CENTAVOS) throw new BabyError("invalid-amount", `${field} must be ₱0 or more`);
  return value;
}

const CATEGORY_FIELDS = ["name", "budget", "order"];
export function validateCategoryInput(input, { partial = false } = {}) {
  only(input, CATEGORY_FIELDS, "category");
  const has = (k) => !partial || Object.hasOwn(input, k);
  const out = {};
  if (has("name")) out.name = text(input.name, { field: "Category name", max: 40, required: true });
  if (has("budget")) out.budget = input.budget === undefined ? null : budgetAmount(input.budget, "Category budget");
  if (has("order") && input.order !== undefined) {
    if (!Number.isSafeInteger(input.order) || input.order < 0 || input.order > 1000) throw new BabyError("invalid-input", "Invalid position");
    out.order = input.order;
  }
  if (partial && !Object.keys(out).length) throw new BabyError("invalid-input", "Nothing to change");
  return out;
}

export function validateBudgetTotal(value) {
  if (value === undefined) throw new BabyError("invalid-input", "Enter the total budget");
  return budgetAmount(value, "Total budget");
}

// ---------- Providers / vendors ----------

export const PROVIDER_TYPES = Object.freeze({
  medical: { label: "Medical / Clinic" },
  pharmacy: { label: "Pharmacy" },
  baby_store: { label: "Baby Store" },
  online_shop: { label: "Online Shop" },
  services: { label: "Services" },
  childcare: { label: "Childcare" },
  other: { label: "Other" },
});
export const PROVIDER_TYPE_IDS = Object.freeze(Object.keys(PROVIDER_TYPES));
export const PROVIDER_STATUSES = Object.freeze({ active: { label: "Active" }, inactive: { label: "Inactive" } });

const PROVIDER_FIELDS = ["name", "type", "phone", "email", "location", "notes"];
export function validateProviderInput(input, { partial = false } = {}) {
  only(input, PROVIDER_FIELDS, "provider");
  const has = (k) => !partial || Object.hasOwn(input, k);
  const out = {};
  if (has("name")) out.name = text(input.name, { field: "Provider name", max: 80, required: true });
  if (has("type")) {
    if (!PROVIDER_TYPE_IDS.includes(input.type)) throw new BabyError("invalid-input", "Choose a provider type");
    out.type = input.type;
  }
  if (has("phone")) out.phone = text(input.phone, { field: "Phone", max: 30 });
  if (has("email")) {
    out.email = text(input.email, { field: "Email", max: 120 });
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new BabyError("invalid-input", "Enter a valid email");
  }
  if (has("location")) out.location = text(input.location, { field: "Address / location", max: 160 });
  if (has("notes")) out.notes = text(input.notes, { field: "Notes", max: 500 });
  if (partial && !Object.keys(out).length) throw new BabyError("invalid-input", "Nothing to change");
  return out;
}

// ---------- Payment schedule ----------

// Stable ids; labels are display text only.
export const SCHEDULE_STATUSES = Object.freeze({ upcoming: { label: "Upcoming" }, paid: { label: "Paid" }, cancelled: { label: "Cancelled" } });
export const SCHEDULE_STATUS_IDS = Object.freeze(Object.keys(SCHEDULE_STATUSES));

const SCHEDULE_FIELDS = ["description", "category", "providerId", "payee", "amount", "dueDate", "notes"];
export function validateScheduleInput(input, { partial = false } = {}) {
  only(input, SCHEDULE_FIELDS, "scheduled payment");
  const has = (k) => !partial || Object.hasOwn(input, k);
  const out = {};
  if (has("description")) out.description = text(input.description, { field: "Description", max: 100, required: true });
  if (has("category")) {
    if (!isValidRecordId(input.category)) throw new BabyError("invalid-input", "Choose a category");
    out.category = input.category;
  }
  if (has("providerId")) {
    if (input.providerId !== null && input.providerId !== undefined && !isValidRecordId(input.providerId)) throw new BabyError("invalid-input", "Choose a provider");
    out.providerId = input.providerId ?? null;
  }
  if (has("payee")) out.payee = text(input.payee, { field: "Payee", max: 120 });
  if (has("amount")) {
    if (!isCentavos(input.amount) || input.amount <= 0) throw new BabyError("invalid-amount", "Amount must be more than ₱0");
    if (input.amount > MAX_PAYMENT_CENTAVOS) throw new BabyError("invalid-amount", "That amount is too large for one payment");
    out.amount = input.amount;
  }
  if (has("dueDate")) {
    if (!isDayId(input.dueDate)) throw new BabyError("invalid-input", "Choose a valid due date");
    out.dueDate = input.dueDate;
  }
  if (has("notes")) out.notes = text(input.notes, { field: "Notes", max: 500 });
  if (partial && !Object.keys(out).length) throw new BabyError("invalid-input", "Nothing to change");
  return out;
}

// ---------- The budget arithmetic ----------

const int = (v) => (Number.isSafeInteger(v) ? v : 0);

// The overall figures, as of now, from budgets/current (null / missing =
// nothing recorded yet). remaining is null while no budget is set.
export function budgetSummary(doc) {
  const d = doc && typeof doc === "object" ? doc : {};
  const total = Number.isSafeInteger(d.total) ? d.total : null;
  const spent = int(d.spent);
  return {
    total,
    spent,
    remaining: total === null ? null : total - spent,
    upcoming: int(d.upcoming),
    upcomingCount: int(d.upcomingCount),
    expenseCount: int(d.expenseCount),
    percentUsed: total ? Math.round((spent * 1000) / total) / 10 : null,
  };
}

// One row per category (the Budget screen, the dashboard list and the
// Excel "Category Budget" sheet all use this): budget, spent, remaining,
// upcoming. `categories` in display order.
export function budgetLines(doc, categories) {
  const d = doc && typeof doc === "object" ? doc : {};
  const spentBy = d.spentByCategory && typeof d.spentByCategory === "object" ? d.spentByCategory : {};
  const upcomingBy = d.upcomingByCategory && typeof d.upcomingByCategory === "object" ? d.upcomingByCategory : {};
  return (categories || []).map((c) => {
    const budget = Number.isSafeInteger(c.budget) ? c.budget : null;
    const spent = int(spentBy[c.id]);
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      order: c.order,
      budget,
      spent,
      remaining: budget === null ? null : budget - spent,
      upcoming: int(upcomingBy[c.id]),
      percentUsed: budget ? Math.round((spent * 1000) / budget) / 10 : null,
    };
  });
}

// Category display order: `order`, then name, then id.
export function sortCategories(list) {
  return [...(list || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.nameLower ?? a.name ?? "").localeCompare(String(b.nameLower ?? b.name ?? "")) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------- Budget threshold alerts ----------

// The overall budget's alert levels (percent used). One notification per
// level per budget "episode": changing the total budget starts a new
// episode (the levels already reached at that moment don't alert again).
export const BUDGET_THRESHOLDS = Object.freeze([75, 90, 100]);

// The highest threshold reached, or 0 (also 0 while no budget is set).
export function thresholdLevel(spent, total) {
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(spent)) return 0;
  let level = 0;
  for (const t of BUDGET_THRESHOLDS) if (spent * 100 >= total * t) level = t;
  return level;
}
