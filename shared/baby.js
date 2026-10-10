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

// ---------- Who paid (Phase 18.6) ----------

// An expense's "Paid by": one or more people (custom names: Mom, Dad, Lola
// Rosa…) and how much each put in. The parts must add up to the expense,
// so a purchase two people shared is counted ONCE in Total spent and split
// across their payer totals. Stored as [{ key, name, amount }]; `key` is a
// normalized name (the payer total's map key), `name` the display text.
// null = not recorded (older expenses): shown as "Not set".
export const MAX_PAYERS_PER_EXPENSE = 5;
export const PAYER_NOT_SET = "Not set";

export function payerKey(name) {
  const k = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return k || null;
}

// Validates the shape; the sum check needs the expense amount (amount =
// null skips it: a partial edit checks it once the amount is known).
export function validatePaidBy(list, amount = null) {
  if (list === undefined || list === null || (Array.isArray(list) && !list.length)) return null;
  if (!Array.isArray(list)) throw new BabyError("invalid-input", "Invalid Paid by");
  if (list.length > MAX_PAYERS_PER_EXPENSE) throw new BabyError("invalid-input", `At most ${MAX_PAYERS_PER_EXPENSE} people can share one expense`);
  const seen = new Set();
  const out = list.map((p) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new BabyError("invalid-input", "Invalid Paid by");
    for (const k of Object.keys(p)) if (!["name", "amount"].includes(k)) throw new BabyError("invalid-input", "Invalid Paid by");
    const name = text(p.name, { field: "Paid by name", max: 40, required: true });
    const key = payerKey(name);
    if (!key) throw new BabyError("invalid-input", "Use letters or numbers in the payer's name");
    if (seen.has(key)) throw new BabyError("invalid-input", `${name} is listed twice`);
    seen.add(key);
    if (!isCentavos(p.amount) || p.amount <= 0) throw new BabyError("invalid-amount", `${name}'s share must be more than ₱0`);
    return { key, name, amount: p.amount };
  });
  if (amount !== null) checkPaidBySum(out, amount);
  return out;
}

export function checkPaidBySum(paidBy, amount) {
  if (!paidBy) return;
  const sum = paidBy.reduce((s, p) => s + p.amount, 0);
  if (sum !== amount) throw new BabyError("paid-by-mismatch", `The shares add up to ₱${(sum / 100).toFixed(2)}, not the expense amount ₱${(amount / 100).toFixed(2)}`);
}

// The expense form's single "Paid by" box: "Mom" (paid it all) or
// "Mom 600, Dad 400" (shares). One name without an amount takes whatever
// the others didn't cover. Returns [{ name, amount }] (centavos) or null
// for an empty box; throws BabyError with a plain message otherwise.
export function parsePaidByText(value, amount) {
  const t = typeof value === "string" ? value.trim() : "";
  if (!t) return null;
  const parts = t.split(/\s*(?:,|;|\+|&|\band\b)\s*/i).filter(Boolean);
  const rows = parts.map((p) => {
    const m = /^(.*?)\s*(?:₱|php|p)?\s*([\d,]+(?:\.\d{1,2})?)$/i.exec(p);
    if (m && m[1].trim()) return { name: m[1].trim(), amount: Math.round(Number(m[2].replace(/,/g, "")) * 100) };
    return { name: p.trim(), amount: null };
  });
  const open = rows.filter((r) => r.amount === null);
  if (open.length > 1) throw new BabyError("invalid-input", 'Add each person\'s share, e.g. "Mom 600, Dad 400"');
  if (open.length === 1) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new BabyError("invalid-input", "Enter the amount first");
    const rest = amount - rows.reduce((s, r) => s + (r.amount ?? 0), 0);
    if (rest <= 0) throw new BabyError("paid-by-mismatch", "The shares already cover the whole amount");
    open[0].amount = rest;
  }
  return rows;
}

// The inverse, to show / pre-fill the box.
export function paidByText(list) {
  if (!Array.isArray(list) || !list.length) return "";
  if (list.length === 1) return list[0].name;
  return list.map((p) => `${p.name} ${Number.isInteger(p.amount / 100) ? p.amount / 100 : (p.amount / 100).toFixed(2)}`).join(", ");
}

// Payer totals for the Dashboard: one row per payer from
// budgets/current.spentByPayer (+ payerNames), biggest first, plus "Not
// set" for spending recorded without a payer (older expenses).
export function payerTotals(doc) {
  const d = doc && typeof doc === "object" ? doc : {};
  const by = d.spentByPayer && typeof d.spentByPayer === "object" ? d.spentByPayer : {};
  const names = d.payerNames && typeof d.payerNames === "object" ? d.payerNames : {};
  const rows = Object.entries(by)
    .filter(([, v]) => Number.isSafeInteger(v) && v !== 0)
    .map(([key, amount]) => ({ key, name: names[key] || key, amount }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  const unset = int(d.spent) - rows.reduce((s, r) => s + r.amount, 0);
  if (unset > 0) rows.push({ key: null, name: PAYER_NOT_SET, amount: unset });
  return rows;
}

// ---------- Scheduled payments paid in parts (Phase 18.6) ----------

// What a scheduled payment still counts in Upcoming: its unpaid part while
// Upcoming, nothing once Paid or Cancelled. paidAmount = the parts paid so
// far (each part is one expense).
export function upcomingPart(s) {
  if (!s || s.status !== "upcoming") return 0;
  return Math.max(0, int(s.amount) - int(s.paidAmount));
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

// Phase 18.6 (Baby): the Total budget is the sum of the category budgets
// (every category, hidden ones included, because their spending still
// counts in Spent). null when no category has a budget: expenses are still
// tracked, there's just no budget to compare against.
export function totalFromCategories(categories) {
  let total = null;
  for (const c of categories || []) if (Number.isSafeInteger(c.budget)) total = (total ?? 0) + c.budget;
  return total;
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
