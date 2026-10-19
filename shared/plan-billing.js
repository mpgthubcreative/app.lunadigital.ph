// How each plan is sold and billed (Super Admin consolidation, 2026-10-19).
// One definition for the server (invoices, renewals, the action center) and
// the console (price labels, Create Business, Plans). Prices live in the
// stored plan (plans/{planId}.pricing, editable in Super Admin); nothing
// else hard-codes them.
//
//   monthly  Distributor: a recurring monthly subscription (+ setup fee).
//            Next due date; overdue after it; counts as recurring income.
//   annual   Luna Household: annual access. Start date, then a renewal date
//            a year after each payment.
//   term     Luna Bridal: 12-month wedding access, bought once. Access until
//            a date, NO automatic renewal; Active / Expiring soon / Expired /
//            Extended, never monthly Past Due logic.
//
// One stored fact drives every date: subscription.paidThrough (the last
// day paid for), with the start date for a subscription not paid yet.
// Money: integer centavos (PHP). Days: business-local YYYY-MM-DD.

export const BILLING_TYPES = Object.freeze({
  monthly: { label: "Monthly subscription", per: "month", recurring: true },
  annual: { label: "Annual access", per: "year", recurring: false },
  term: { label: "12-month access", per: "12 months", recurring: false },
});
export const BILLING_TYPE_IDS = Object.freeze(Object.keys(BILLING_TYPES));

// No commercial limit (orders today): a number no business reaches, so
// the existing limit machinery keeps working; shown as "No limit".
export const UNLIMITED = 1_000_000;
export const isUnlimited = (v) => Number.isSafeInteger(v) && v >= UNLIMITED;

// Accounts that never use a paid seat: a kasambahay's own login. (Wedding
// guests and invitation visitors aren't members at all.)
export const NON_SEAT_ROLES = Object.freeze(["household_staff"]);
export const usesSeat = (member) => Boolean(member) && !NON_SEAT_ROLES.includes(member.roleTemplate);

// The billing terms of a plan. Plans stored before this had only a monthly
// price: they read as monthly.
export function planBilling(plan) {
  const p = plan?.pricing || {};
  const type = BILLING_TYPE_IDS.includes(p.billingType) ? p.billingType : "monthly";
  const price = Number.isSafeInteger(p.price) ? p.price : Number.isSafeInteger(p.monthly) ? p.monthly : 0;
  return {
    type,
    price,
    priceIsMinimum: p.priceIsMinimum === true || (type === "monthly" && p.monthlyIsMinimum === true),
    setupFee: Number.isSafeInteger(p.setupFee) ? p.setupFee : 0,
    termMonths: type === "monthly" ? 1 : Number.isSafeInteger(p.termMonths) && p.termMonths > 0 ? p.termMonths : 12,
    autoRenew: type === "term" ? p.autoRenew === true : p.autoRenew !== false,
    founding: p.founding && Number.isSafeInteger(p.founding.price) ? { price: p.founding.price, months: Number.isSafeInteger(p.founding.months) ? p.founding.months : 12, label: typeof p.founding.label === "string" ? p.founding.label : null } : null,
  };
}

const pesos = (c) => `₱${Math.round((c || 0) / 100).toLocaleString("en-PH")}`;
// "₱499 / month + ₱999 setup", "₱1,190 / year", "Starting at ₱3,990 / 12 months".
export function priceLabel(plan) {
  const b = planBilling(plan);
  const main = `${b.priceIsMinimum ? "Starting at " : ""}${pesos(b.price)} / ${BILLING_TYPES[b.type].per}`;
  return b.setupFee ? `${main} + ${pesos(b.setupFee)} setup` : main;
}

// ---------- Dates ----------

export function addMonths(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
export function shiftDay(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Days from `from` to `to` (0 = same day; negative = past). Not reports.js daysBetween (inclusive).
export function daysUntil(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDayString = (v) => typeof v === "string" && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

// ---------- A subscription's terms ----------

// Written when a business gets a plan (create / change plan): the price
// snapshot and the start date. `founding`: the founding price applies for
// the plan's founding months from the start date.
export function newSubscriptionTerms(plan, startDate, { founding = false } = {}) {
  // A legacy plan (no billing type: Starter / Growth / Pro) keeps the old
  // calendar-month billing (due the 7th): only its monthly price.
  if (!BILLING_TYPE_IDS.includes(plan?.pricing?.billingType)) return { monthlyAmount: Number.isSafeInteger(plan?.pricing?.monthly) ? plan.pricing.monthly : 0 };
  const b = planBilling(plan);
  const f = founding && b.founding ? { price: b.founding.price, until: addMonths(startDate, b.founding.months) } : null;
  return {
    billingType: b.type,
    amount: b.price,
    setupFee: b.setupFee,
    autoRenew: b.autoRenew,
    termMonths: b.termMonths,
    startDate,
    founding: f,
    // Term (Bridal): access for the term from the start, no renewal.
    accessUntil: b.type === "term" ? shiftDay(addMonths(startDate, b.termMonths), -1) : null,
    // Recurring income (MRR) only: never a yearly or one-time price.
    monthlyAmount: b.type === "monthly" ? (f ? f.price : b.price) : 0,
  };
}

// The price of the period starting `due` (the founding price while it lasts).
export function amountFor(sub, due) {
  if (sub?.founding && Number.isSafeInteger(sub.founding.price) && sub.founding.until && due < sub.founding.until) return sub.founding.price;
  return Number.isSafeInteger(sub?.amount) ? sub.amount : Number.isSafeInteger(sub?.monthlyAmount) ? sub.monthlyAmount : null;
}

// What one payment covers when it's due on `due`: [due, end].
export function coverEnd(billingType, due, termMonths = 12) {
  return shiftDay(addMonths(due, billingType === "monthly" ? 1 : termMonths), -1);
}

// The terms of a stored subscription. Older businesses without billing
// fields read as their plan / workspace says, starting on their creation
// day (read-only: nothing is written back).
export function subscriptionTerms(sub = {}, { plan = null, createdDay = null } = {}) {
  const b = plan ? planBilling(plan) : null;
  const type = BILLING_TYPE_IDS.includes(sub.billingType) ? sub.billingType : b?.type ?? "monthly";
  const startDate = isDayString(sub.startDate) ? sub.startDate : createdDay;
  const termMonths = Number.isSafeInteger(sub.termMonths) ? sub.termMonths : b?.termMonths ?? (type === "monthly" ? 1 : 12);
  const paidThrough = isDayString(sub.paidThrough) ? sub.paidThrough : null;
  // The next payment is due the day after what's paid, else on the start
  // date; an operator's changed due date wins.
  const nextDue = isDayString(sub.dueDate) ? sub.dueDate : paidThrough ? shiftDay(paidThrough, 1) : startDate;
  return {
    billingType: type,
    amount: amountFor(sub, nextDue ?? "9999-12-31") ?? b?.price ?? null,
    autoRenew: typeof sub.autoRenew === "boolean" ? sub.autoRenew : b?.autoRenew ?? type !== "term",
    termMonths,
    startDate,
    paidThrough,
    // monthly: next due date. annual: first payment, then the renewal date.
    // term: the one purchase (null once paid: no renewal).
    dueDate: type === "term" && paidThrough ? null : nextDue,
    renewal: type === "annual" && Boolean(paidThrough),
    accessUntil: type === "term" ? (isDayString(sub.accessUntil) ? sub.accessUntil : startDate ? shiftDay(addMonths(startDate, termMonths), -1) : null) : null,
    extended: sub.extended === true,
  };
}

// What needs attention, with the date that matters (null: nothing soon).
export const SOON = Object.freeze({ monthly: 7, annual: 30, term: 30 });
export function attentionOf(terms, { status = "active", today } = {}) {
  if (!terms || !today || ["cancelled", "deleted"].includes(status)) return null;
  const t = terms.billingType;
  const due = terms.dueDate;
  if (due) {
    const left = daysUntil(today, due);
    const what = t === "annual" ? (terms.renewal ? "Renewal due" : "Payment due") : t === "term" ? "Payment due" : "Due";
    if (left < 0) return { kind: "overdue", date: due, days: -left, label: `${-left} day${left === -1 ? "" : "s"} overdue`, what, tone: "danger" };
    if (left <= SOON[t]) return { kind: "due", date: due, days: left, label: left === 0 ? "Due today" : "Due soon", what, tone: "warning" };
  }
  if (t === "term" && terms.accessUntil) {
    const left = daysUntil(today, terms.accessUntil);
    if (left < 0) return { kind: "expired", date: terms.accessUntil, days: -left, label: "Expired", what: "Access ended", tone: "danger" };
    if (left <= SOON.term) return { kind: "expiring", date: terms.accessUntil, days: left, label: "Expiring soon", what: "Access ends", tone: "warning" };
  }
  return null;
}

// The status word for a subscription row: Bridal never uses Past Due.
export function accessState(terms, { status = "active", today } = {}) {
  if (["suspended", "cancelled", "deleted"].includes(status)) return status;
  if (terms?.billingType === "term" && terms.accessUntil && today) {
    const left = daysUntil(today, terms.accessUntil);
    if (left < 0) return "expired";
    if (left <= SOON.term) return "expiring";
    if (terms.extended) return "extended";
    return "active";
  }
  return status;
}
