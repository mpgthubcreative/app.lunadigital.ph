// Bridal / Wedding Command Center (Phase 16): the shared vocabulary,
// validation and the derived figures. The operational side of a wedding:
// budget, expenses, suppliers and their balances, supplier payments, tasks
// and guests / RSVP. Not project management, not accounting. Server and UI
// use the same functions; only the server writes.
//
// Records (businesses/{bid}/...):
//   budgets/current, expenseCategories/{id}, spendingMetrics/{day|month}
//                            the generic budget primitive shared with Baby
//                            (Phase 15): total, spent, remaining, category
//                            lines, upcoming. Bridal adds contracted /
//                            contractedPaid (supplier agreements) and
//                            spendingMetrics.supplierPaid.
//   expenses/{id}            the Expenses Core record (shared/expenses.js),
//                            Bridal profile: tenant category, optional
//                            supplierId (payee = the supplier's name
//                            snapshot), server-set supplierPaymentId
//   weddingSuppliers/{id}    name, service, contact, agreedAmount (optional
//                            contract), and Luna's paid / upcoming / nextDue
//   supplierPayments/{id}    Upcoming -> Paid (exactly one linked Wedding
//                            Expense) or Cancelled
//   weddingTasks/{id}        task, category, assignee, due date, priority,
//                            status (+ open, completedAt / completedBy)
//   taskTotals/current       open / completed / cancelled / total counters
//   guests/{id}              guest or household, group, side, party size,
//                            RSVP status, confirmed attendees
//   guestTotals/current      invitations / seats per RSVP status
//
// Luna computes, nobody types:
//   Supplier paid    = the supplier's active Wedding Expenses
//   Supplier balance = agreed amount - paid (only with an agreement)
//   Supplier balance (dashboard) = contracted - contractedPaid
//   Overdue task     = open + due date before the business's today (derived,
//                      never stored)
//   Confirmed guests = sum of confirmed attendees (people, not records)

import { isDayId, addDays } from "./metrics.js";
import { isCentavos } from "./quantity.js";
import { isValidRecordId, budgetSummary } from "./baby.js";

export const WEDDING_SCHEMA_VERSION = 1;
export const TOTALS_DOC_ID = "current";

export class WeddingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const MAX_AGREED_CENTAVOS = 10_000_000_000; // ₱100,000,000 (typo guard)
export const MAX_PARTY_SIZE = 50;

function text(value, { field, max, required = false }) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new WeddingError("invalid-input", `${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new WeddingError("invalid-input", `${field} must be text`);
  const t = value.trim().replace(/\s+/g, " ");
  if (t.length > max) throw new WeddingError("invalid-input", `${field} is too long (max ${max})`);
  if (!t && required) throw new WeddingError("invalid-input", `${field} is required`);
  return t || null;
}
function only(input, fields, what) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WeddingError("invalid-input", `Invalid ${what}`);
  for (const k of Object.keys(input)) if (!fields.includes(k)) throw new WeddingError("invalid-input", `Field ${k} can't be set here`);
}
const lower = (s) => (s || "").toLocaleLowerCase("en");
export const keyOf = (s) => (s ? lower(s.trim().replace(/\s+/g, " ")) : null);

// ---------- Budget categories ----------

// Offered once on an empty wedding budget; tenant data from then on.
export const SUGGESTED_WEDDING_CATEGORIES = Object.freeze(["Venue", "Ceremony / Church", "Catering", "Styling / Flowers", "Photo / Video", "Attire", "Hair / Makeup", "Invitations / Stationery", "Entertainment", "Cake / Desserts", "Transportation", "Accommodation", "Gifts / Souvenirs", "Documents / Legal", "Coordinator", "Miscellaneous"]);

// ---------- Suppliers ----------

export const SUPPLIER_SERVICES = Object.freeze({
  venue: { label: "Venue" },
  church: { label: "Ceremony / Church" },
  catering: { label: "Catering" },
  styling: { label: "Styling / Flowers" },
  photo_video: { label: "Photo / Video" },
  attire: { label: "Gown / Suit" },
  hair_makeup: { label: "Hair / Makeup" },
  coordinator: { label: "Coordinator" },
  entertainment: { label: "Entertainment / Music" },
  cake: { label: "Cake / Desserts" },
  stationery: { label: "Invitations / Stationery" },
  transport: { label: "Transportation" },
  accommodation: { label: "Accommodation" },
  other: { label: "Other" },
});
export const SUPPLIER_SERVICE_IDS = Object.freeze(Object.keys(SUPPLIER_SERVICES));
export const SUPPLIER_STATUSES = Object.freeze({ active: { label: "Active" }, inactive: { label: "Inactive" } });

function agreed(value) {
  if (value === null || value === undefined) return null;
  if (!isCentavos(value) || value > MAX_AGREED_CENTAVOS) throw new WeddingError("invalid-amount", "The agreed amount must be ₱0 or more");
  return value;
}

const SUPPLIER_FIELDS = ["name", "service", "contactPerson", "phone", "email", "location", "agreedAmount", "categoryId", "notes"];
export function validateSupplierInput(input, { partial = false } = {}) {
  only(input, SUPPLIER_FIELDS, "supplier");
  const has = (k) => !partial || Object.hasOwn(input, k);
  const out = {};
  if (has("name")) out.name = text(input.name, { field: "Supplier name", max: 80, required: true });
  if (has("service")) {
    if (!SUPPLIER_SERVICE_IDS.includes(input.service)) throw new WeddingError("invalid-input", "Choose a service");
    out.service = input.service;
  }
  if (has("contactPerson")) out.contactPerson = text(input.contactPerson, { field: "Contact person", max: 80 });
  if (has("phone")) out.phone = text(input.phone, { field: "Phone", max: 30 });
  if (has("email")) {
    out.email = text(input.email, { field: "Email", max: 120 });
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new WeddingError("invalid-input", "Enter a valid email");
  }
  if (has("location")) out.location = text(input.location, { field: "Address / location", max: 160 });
  if (has("agreedAmount")) out.agreedAmount = agreed(input.agreedAmount);
  if (has("categoryId")) {
    if (input.categoryId !== null && input.categoryId !== undefined && !isValidRecordId(input.categoryId)) throw new WeddingError("invalid-input", "Choose a budget category");
    out.categoryId = input.categoryId ?? null;
  }
  if (has("notes")) out.notes = text(input.notes, { field: "Notes", max: 500 });
  if (partial && !Object.keys(out).length) throw new WeddingError("invalid-input", "Nothing to change");
  return out;
}

// Agreed - paid; null without an agreement. Negative never happens (Luna
// refuses payments beyond the agreed amount), but is shown as-is if it did.
export function supplierBalance(s) {
  if (!s || !Number.isSafeInteger(s.agreedAmount)) return null;
  return s.agreedAmount - (Number.isSafeInteger(s.paid) ? s.paid : 0);
}

// ---------- Supplier payments ----------

export const SUPPLIER_PAYMENT_STATUSES = Object.freeze({ upcoming: { label: "Upcoming" }, paid: { label: "Paid" }, cancelled: { label: "Cancelled" } });
export const SUPPLIER_PAYMENT_STATUS_IDS = Object.freeze(Object.keys(SUPPLIER_PAYMENT_STATUSES));

const PAYMENT_FIELDS = ["supplierId", "description", "category", "amount", "dueDate", "notes"];
export function validateSupplierPaymentInput(input, { partial = false } = {}) {
  only(input, PAYMENT_FIELDS, "supplier payment");
  const has = (k) => !partial || Object.hasOwn(input, k);
  const out = {};
  if (has("supplierId")) {
    if (partial) throw new WeddingError("invalid-input", "A payment's supplier can't be changed: cancel it and schedule a new one");
    if (!isValidRecordId(input.supplierId)) throw new WeddingError("invalid-input", "Choose a supplier");
    out.supplierId = input.supplierId;
  }
  if (has("description")) out.description = text(input.description, { field: "Description", max: 100, required: true });
  if (has("category")) {
    if (!isValidRecordId(input.category)) throw new WeddingError("invalid-input", "Choose a budget category");
    out.category = input.category;
  }
  if (has("amount")) {
    if (!isCentavos(input.amount) || input.amount <= 0) throw new WeddingError("invalid-amount", "Amount must be more than ₱0");
    if (input.amount > MAX_AGREED_CENTAVOS) throw new WeddingError("invalid-amount", "That amount is too large for one payment");
    out.amount = input.amount;
  }
  if (has("dueDate")) {
    if (!isDayId(input.dueDate)) throw new WeddingError("invalid-input", "Choose a valid due date");
    out.dueDate = input.dueDate;
  }
  if (has("notes")) out.notes = text(input.notes, { field: "Notes", max: 500 });
  if (partial && !Object.keys(out).length) throw new WeddingError("invalid-input", "Nothing to change");
  return out;
}

// ---------- Tasks ----------

export const TASK_STATUSES = Object.freeze({
  not_started: { label: "Not Started", open: true },
  in_progress: { label: "In Progress", open: true },
  completed: { label: "Completed", open: false },
  cancelled: { label: "Cancelled", open: false },
});
export const TASK_STATUS_IDS = Object.freeze(Object.keys(TASK_STATUSES));
export const isOpenStatus = (s) => TASK_STATUSES[s]?.open === true;
export const TASK_PRIORITIES = Object.freeze({ high: { label: "High" }, normal: { label: "Normal" }, low: { label: "Low" } });
export const TASK_PRIORITY_IDS = Object.freeze(Object.keys(TASK_PRIORITIES));
// Suggestions only: a task's category is the family's own short text.
export const SUGGESTED_TASK_CATEGORIES = Object.freeze(["Venue", "Ceremony / Church", "Suppliers", "Attire", "Invitations", "Documents", "Reception", "Styling", "Photo / Video", "Honeymoon", "Other"]);
export const DUE_SOON_DAYS = 7;

const TASK_FIELDS = ["title", "category", "assignee", "dueDate", "priority", "notes"];
export function validateTaskInput(input, { partial = false } = {}) {
  only(input, TASK_FIELDS, "task");
  const has = (k) => !partial || Object.hasOwn(input, k);
  const out = {};
  if (has("title")) out.title = text(input.title, { field: "Task", max: 120, required: true });
  if (has("category")) out.category = text(input.category, { field: "Category", max: 40 });
  // Free text (MVP): bridesmaids, family and coordinators needn't be Luna users.
  if (has("assignee")) out.assignee = text(input.assignee, { field: "Assigned to", max: 60 });
  if (has("dueDate")) {
    if (input.dueDate !== null && input.dueDate !== undefined && input.dueDate !== "" && !isDayId(input.dueDate)) throw new WeddingError("invalid-input", "Choose a valid due date");
    out.dueDate = input.dueDate || null;
  }
  // Optional on a new task (Normal by default).
  if (has("priority") && !(input.priority === undefined && !partial)) {
    if (!TASK_PRIORITY_IDS.includes(input.priority)) throw new WeddingError("invalid-input", "Choose a priority");
    out.priority = input.priority;
  }
  if (has("notes")) out.notes = text(input.notes, { field: "Notes", max: 500 });
  if (partial && !Object.keys(out).length) throw new WeddingError("invalid-input", "Nothing to change");
  return out;
}

// Derived, never stored: "overdue" | "due_soon" | null.
export function taskTiming(task, today) {
  if (!task || !isOpenStatus(task.status) || !isDayId(task.dueDate) || !isDayId(today)) return null;
  if (task.dueDate < today) return "overdue";
  if (task.dueDate <= addDays(today, DUE_SOON_DAYS)) return "due_soon";
  return null;
}

// Counter deltas for taskTotals/current when a task goes from `before` to
// `after` (either may be null).
export function taskTotalsDelta(before, after) {
  const d = { total: 0, open: 0, completed: 0, cancelled: 0 };
  const add = (t, sign) => {
    if (!t) return;
    d.total += sign;
    if (isOpenStatus(t.status)) d.open += sign;
    else if (t.status === "completed") d.completed += sign;
    else if (t.status === "cancelled") d.cancelled += sign;
  };
  add(before, -1);
  add(after, 1);
  return d;
}

// ---------- Guests / RSVP ----------

export const RSVP_STATUSES = Object.freeze({ awaiting: { label: "Awaiting RSVP" }, attending: { label: "Attending" }, declined: { label: "Declined" } });
export const RSVP_STATUS_IDS = Object.freeze(Object.keys(RSVP_STATUSES));
export const GUEST_SIDES = Object.freeze({ bride: { label: "Bride's side" }, groom: { label: "Groom's side" }, both: { label: "Both / Mutual" } });
export const GUEST_SIDE_IDS = Object.freeze(Object.keys(GUEST_SIDES));

const GUEST_FIELDS = ["name", "group", "side", "contact", "partySize", "invitationSent", "notes"];
export function validateGuestInput(input, { partial = false } = {}) {
  only(input, GUEST_FIELDS, "guest");
  const has = (k) => !partial || Object.hasOwn(input, k);
  const out = {};
  if (has("name")) out.name = text(input.name, { field: "Guest or household", max: 100, required: true });
  if (has("group")) out.group = text(input.group, { field: "Group", max: 60 });
  if (has("side")) {
    if (!GUEST_SIDE_IDS.includes(input.side)) throw new WeddingError("invalid-input", "Choose a side");
    out.side = input.side;
  }
  if (has("contact")) out.contact = text(input.contact, { field: "Contact", max: 120 });
  if (has("partySize")) {
    if (!Number.isSafeInteger(input.partySize) || input.partySize < 1 || input.partySize > MAX_PARTY_SIZE) throw new WeddingError("invalid-input", `Party size must be 1 to ${MAX_PARTY_SIZE}`);
    out.partySize = input.partySize;
  }
  if (has("invitationSent")) {
    if (input.invitationSent !== null && input.invitationSent !== undefined && input.invitationSent !== "" && !isDayId(input.invitationSent)) throw new WeddingError("invalid-input", "Choose a valid invitation date");
    out.invitationSent = input.invitationSent || null;
  }
  if (has("notes")) out.notes = text(input.notes, { field: "Notes", max: 500 });
  if (partial && !Object.keys(out).length) throw new WeddingError("invalid-input", "Nothing to change");
  return out;
}

// An RSVP answer for a guest of `partySize`:
//   attending -> 1..partySize confirmed; declined / awaiting -> 0 (a
//   confirmed count sent with them must be 0).
export function validateRsvp({ status, confirmed } = {}, partySize) {
  if (!RSVP_STATUS_IDS.includes(status)) throw new WeddingError("invalid-input", "Choose an RSVP status");
  if (status !== "attending") {
    if (confirmed !== undefined && confirmed !== null && confirmed !== 0) throw new WeddingError("invalid-input", `${RSVP_STATUSES[status].label} means 0 confirmed guests`);
    return { status, confirmed: 0 };
  }
  if (!Number.isSafeInteger(confirmed) || confirmed < 1) throw new WeddingError("invalid-input", "Attending needs at least 1 confirmed guest");
  if (confirmed > partySize) throw new WeddingError("invalid-input", `Confirmed guests can't be more than the party size (${partySize})`);
  return { status, confirmed };
}

// One guest's contribution to guestTotals/current. Records ("invitations")
// and people ("seats") are counted separately.
export function guestContribution(g) {
  const z = { invitations: 0, invitedSeats: 0, attending: 0, attendingSeats: 0, declined: 0, declinedSeats: 0, awaiting: 0, awaitingSeats: 0, invitationsSent: 0 };
  if (!g) return z;
  const size = Number.isSafeInteger(g.partySize) ? g.partySize : 0;
  z.invitations = 1;
  z.invitedSeats = size;
  if (g.invitationSent) z.invitationsSent = 1;
  if (g.rsvp === "attending") {
    z.attending = 1;
    z.attendingSeats = Number.isSafeInteger(g.confirmed) ? g.confirmed : 0;
  } else if (g.rsvp === "declined") {
    z.declined = 1;
    z.declinedSeats = size;
  } else {
    z.awaiting = 1;
    z.awaitingSeats = size;
  }
  return z;
}
export function guestDelta(before, after) {
  const a = guestContribution(after);
  const b = guestContribution(before);
  return Object.fromEntries(Object.keys(a).map((k) => [k, a[k] - b[k]]));
}

const int = (v) => (Number.isSafeInteger(v) ? v : 0);
export function rsvpSummary(doc) {
  const d = doc && typeof doc === "object" ? doc : {};
  return Object.fromEntries(Object.keys(guestContribution(null)).map((k) => [k, int(d[k])]));
}

// ---------- Dashboard figures ----------

// The wedding budget as of now: Baby's budget arithmetic + supplier balance.
export function weddingSummary(doc) {
  const d = doc && typeof doc === "object" ? doc : {};
  return { ...budgetSummary(d), contracted: int(d.contracted), contractedPaid: int(d.contractedPaid), supplierBalance: int(d.contracted) - int(d.contractedPaid) };
}
