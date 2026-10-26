// How each Luna product is sold and billed (final pricing model, 2026-10-20).
// One definition for the server (invoices, renewals, the action center) and
// the console (Create Business, Change access, Plans). Prices live in the
// stored plan (plans/{planId}.pricing, editable in Super Admin); nothing
// else hard-codes them.
//
// Three separate things:
//   Product  the plan: Luna Household, Distributor, Luna Bridal,
//            Luna Bridal Custom (one public product per workspace, except
//            Bridal's Standard vs Custom invitation service).
//   Term     how long one payment covers (pricing.terms). The product stays
//            the same; only the term changes.
//   Add-ons  extra capacity bought only when needed (pricing.addOns), added
//            on top of the product's included users / storage. A FLAT add-on
//            (flat: true) is one price, bought once and billed on its own
//            bill, never prorated or repeated on term bills; `grants` names
//            what it unlocks (Bridal's Premium wedding link: "customLink").
//
// Billing types:
//   monthly  Distributor: a recurring monthly subscription (+ one-time setup
//            fee). A longer prepaid term (3 months) covers its months, then
//            it's monthly again. Next due date; counts as recurring income.
//   annual   Luna Household: prepaid access for the chosen term (1, 3 or
//            12 months; 12 is the main offer). Access until a date, then
//            "Renewal due".
//   term     Luna Bridal: wedding access for 3 or 6 months, bought once. Access ends
//            on a date, NO automatic renewal; Active / Expiring soon /
//            Expired / Extended, never monthly Past Due logic.
//
// One stored fact drives every date: subscription.paidThrough (the last
// day paid for), with the start date for a subscription not paid yet.
// Money: integer centavos (PHP). Days: business-local YYYY-MM-DD.

import { newTrial, trialOpen } from "./trial.js";

export const BILLING_TYPES = Object.freeze({
  monthly: { label: "Monthly subscription", per: "month", recurring: true },
  annual: { label: "Prepaid access", per: "12 months", recurring: false },
  term: { label: "Wedding access", per: "term", recurring: false },
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

const MB = 1024 * 1024;
const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const pesos = (c) => `₱${Math.round((c || 0) / 100).toLocaleString("en-PH")}`;
export const monthsText = (n) => `${n} month${n === 1 ? "" : "s"}`;

// The billing terms of a plan. Plans stored before terms had only a
// monthly price: they read as monthly with one 1-month term.
export function planBilling(plan) {
  const p = plan?.pricing || {};
  const type = BILLING_TYPE_IDS.includes(p.billingType) ? p.billingType : "monthly";
  const price = Number.isSafeInteger(p.price) ? p.price : int(p.monthly);
  const termMonths = type === "monthly" ? 1 : Number.isSafeInteger(p.termMonths) && p.termMonths > 0 ? p.termMonths : 12;
  const terms = (Array.isArray(p.terms) && p.terms.length ? p.terms : [{ months: termMonths, price, kind: "main" }])
    .filter((t) => t && Number.isSafeInteger(t.months) && t.months > 0 && Number.isSafeInteger(t.price))
    .map((t) => ({ months: t.months, price: t.price, kind: t.kind === "trial" ? "trial" : "main", label: typeof t.label === "string" && t.label ? t.label : null }))
    .sort((a, b) => a.months - b.months);
  const addOns = (Array.isArray(p.addOns) ? p.addOns : [])
    .filter((a) => a && typeof a.id === "string" && Number.isSafeInteger(a.price))
    .map((a) => ({ id: a.id, label: String(a.label || a.id), users: int(a.users), storageMb: int(a.storageMb), price: a.price, perMonths: Number.isSafeInteger(a.perMonths) && a.perMonths > 0 ? a.perMonths : type === "monthly" ? 1 : 12, ...(a.flat === true ? { flat: true } : {}), ...(typeof a.grants === "string" && a.grants ? { grants: a.grants } : {}) }));
  return {
    type,
    price,
    priceIsMinimum: p.priceIsMinimum === true || (type === "monthly" && p.monthlyIsMinimum === true),
    setupFee: int(p.setupFee),
    termMonths,
    terms,
    defaultTermMonths: (terms.find((t) => t.kind === "main" && t.months === termMonths) ?? terms.find((t) => t.kind === "main") ?? terms.at(-1))?.months ?? termMonths,
    addOns,
    autoRenew: type === "term" ? p.autoRenew === true : p.autoRenew !== false,
    // A free trial before the first paid bill (0: none, e.g. Bridal Custom).
    trialDays: Number.isSafeInteger(p.trialDays) && p.trialDays > 0 ? p.trialDays : 0,
  };
}

// "₱499 / month + ₱999 setup", "₱1,190 / 12 months", "Starting at ₱2,990 / 12 months".
export function priceLabel(plan) {
  const b = planBilling(plan);
  const main = `${b.priceIsMinimum ? "Starting at " : ""}${pesos(b.price)} / ${b.type === "monthly" ? "month" : monthsText(b.termMonths)}`;
  return b.setupFee ? `${main} + ${pesos(b.setupFee)} setup` : main;
}
// One term as a choice: "12 months · ₱1,190 · Best Value", "3 months · ₱349 · Paid trial".
export function termLabel(plan, months) {
  const b = planBilling(plan);
  const t = b.terms.find((x) => x.months === months);
  if (!t) return monthsText(months);
  const tag = t.label ?? (t.kind === "trial" ? (b.type === "monthly" ? "Prepaid starter" : "Paid trial") : null);
  const price = b.type === "monthly" && t.months === 1 ? `${pesos(t.price)} / month` : pesos(t.price);
  return [monthsText(t.months), `${b.priceIsMinimum && t.kind === "main" ? "from " : ""}${price}`, tag].filter(Boolean).join(" · ");
}
// "Additional family/admin user · ₱199 / 12 months".
export const addOnLabel = (a) => (a.flat ? `${a.label} · ${pesos(a.price)} once` : `${a.label} · ${pesos(a.price)} / ${a.perMonths === 1 ? "month" : monthsText(a.perMonths)}`);

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

// What one payment covering `months` from `due` covers: [due, end].
export function coverEnd(due, months) {
  return shiftDay(addMonths(due, months), -1);
}

// ---------- Add-ons ----------

// Validates add-on quantities { [addOnId]: qty } against the plan and
// returns the subscription's snapshot: [{ id, label, qty, users, storageMb,
// price, perMonths }] (prices frozen like the plan price).
export function addOnSnapshot(plan, quantities = {}) {
  if (!quantities || typeof quantities !== "object" || Array.isArray(quantities)) throw new Error("Add-ons: invalid");
  const offered = planBilling(plan).addOns;
  const out = [];
  for (const [id, qty] of Object.entries(quantities)) {
    const a = offered.find((x) => x.id === id);
    if (!a) throw new Error(`Add-on ${id} isn't offered for ${plan?.name ?? "this plan"}`);
    if (!Number.isSafeInteger(qty) || qty < 0 || qty > 50) throw new Error(`${a.label}: 0 to 50`);
    if (qty > 0) out.push({ ...a, qty });
  }
  return out;
}
// Extra capacity from a subscription's add-ons.
export function addOnCapacity(addOns) {
  const list = Array.isArray(addOns) ? addOns : [];
  return { users: list.reduce((t, a) => t + int(a.users) * int(a.qty), 0), storageBytes: list.reduce((t, a) => t + int(a.storageMb) * MB * int(a.qty), 0) };
}
// What the add-ons cost for a bill covering `months` (flat add-ons are
// billed once on their own bill, never here).
export function addOnAmount(addOns, months) {
  const list = (Array.isArray(addOns) ? addOns : []).filter((a) => a?.flat !== true);
  return list.reduce((t, a) => t + Math.round((int(a.price) * int(a.qty) * months) / (Number.isSafeInteger(a.perMonths) && a.perMonths > 0 ? a.perMonths : 1)), 0);
}

// ---------- A subscription's terms ----------

// Written when a business gets a product (create / change product): the
// price snapshot, the chosen term and the start date.
//   termMonths     one of the plan's terms (default: the main offer). For
//                  a monthly product, a longer term is a PREPAID first
//                  bill (prepaidTerm) and then it's monthly.
//   priceOverride  Super Admin's agreed price for the term (e.g. a Custom
//                  wedding quoted above "starting at"), or null.
//   addOns         { [addOnId]: qty }.
//   setupFee       the one-time setup fee for this business (default: the
//                  product's); waiveSetupFee: it still shows on the first
//                  bill, with a "Setup fee waived" line taking it off.
//   trial          start with the product's free trial (nothing billed until
//                  a plan is chosen on "Continue with Luna"; shared/trial.js).
export function newSubscriptionTerms(plan, startDate, { termMonths = null, priceOverride = null, addOns = {}, setupFee = null, waiveSetupFee = false, trial = false } = {}) {
  // A legacy plan without a billing type (Starter / Growth / Pro) keeps the
  // old calendar-month billing (due the 7th): only its monthly price.
  if (!BILLING_TYPE_IDS.includes(plan?.pricing?.billingType)) return { monthlyAmount: int(plan?.pricing?.monthly) };
  const b = planBilling(plan);
  const months = termMonths ?? b.defaultTermMonths;
  const term = b.terms.find((t) => t.months === months);
  if (!term) throw new Error(`${plan.name} is sold for ${b.terms.map((t) => monthsText(t.months)).join(", ")}`);
  if (priceOverride !== null && (!Number.isSafeInteger(priceOverride) || priceOverride <= 0)) throw new Error("Price override: an amount more than ₱0");
  if (setupFee !== null && (!Number.isSafeInteger(setupFee) || setupFee < 0 || setupFee > 100_000_000)) throw new Error("Setup fee: ₱0 or more");
  const extras = addOnSnapshot(plan, addOns);
  const monthly = b.type === "monthly";
  const sub = {
    billingType: b.type,
    // The price of one regular bill: the month (monthly) or the chosen term.
    amount: monthly ? b.terms.find((t) => t.months === 1)?.price ?? b.price : term.price,
    termMonths: monthly ? 1 : term.months,
    prepaidTerm: monthly && term.months > 1 ? { months: term.months, price: term.price } : null,
    priceOverride,
    addOns: extras,
    // The one-time setup fee (Luna Distributor ₱250), on the first PAID bill.
    setupFee: setupFee ?? b.setupFee,
    setupFeeBilled: false,
    setupFeeWaived: (setupFee ?? b.setupFee) > 0 && waiveSetupFee === true,
    autoRenew: b.autoRenew,
    startDate,
    // Term (Bridal): access for the term from the start, no renewal.
    accessUntil: b.type === "term" ? shiftDay(addMonths(startDate, term.months), -1) : null,
    ...(trial && b.trialDays ? { ...newTrial(startDate, b.trialDays), conversion: null } : {}),
  };
  return { ...sub, monthlyAmount: recurringAmount(sub) };
}

// Recurring monthly income (MRR) of a subscription: monthly products only,
// never a prepaid, yearly or 12-month price.
export function recurringAmount(sub) {
  if (sub?.billingType !== "monthly") return 0;
  return (Number.isSafeInteger(sub.priceOverride) ? sub.priceOverride : int(sub.amount)) + addOnAmount(sub.addOns, 1);
}

// One bill: { months, amount }. `prepaid`: the monthly product's prepaid
// term applies (the next bill after what's paid).
export function billFigures(sub, { prepaid = false } = {}) {
  const type = BILLING_TYPE_IDS.includes(sub?.billingType) ? sub.billingType : "monthly";
  if (type === "monthly") {
    if (prepaid && sub.prepaidTerm) return { months: sub.prepaidTerm.months, amount: sub.prepaidTerm.price + addOnAmount(sub.addOns, sub.prepaidTerm.months) };
    const base = Number.isSafeInteger(sub.priceOverride) ? sub.priceOverride : Number.isSafeInteger(sub.amount) ? sub.amount : Number.isSafeInteger(sub.monthlyAmount) ? sub.monthlyAmount : null;
    return { months: 1, amount: base === null ? null : base + addOnAmount(sub.addOns, 1) };
  }
  const months = Number.isSafeInteger(sub.termMonths) && sub.termMonths > 0 ? sub.termMonths : 12;
  const base = Number.isSafeInteger(sub.priceOverride) ? sub.priceOverride : Number.isSafeInteger(sub.amount) ? sub.amount : null;
  return { months, amount: base === null ? null : base + addOnAmount(sub.addOns, months) };
}

// ---------- A bill's breakdown (2026-10-20) ----------
//
// A bill keeps its own lines (frozen when it's made; a later price change
// never rewrites it) and its adjustments:
//   lines        { kind: base | addon | setup | upgrade, label, amount }
//   adjustments  { id, type: discount | credit | setup_waived, description, amount }
//                (amount positive = taken off)
//   amountDue    max(0, lines - adjustments)
export const ADJUSTMENT_TYPES = Object.freeze({
  discount: { label: "Discount" },
  credit: { label: "Credit / deduction" },
  setup_waived: { label: "Setup fee waived" },
});
export const ADJUSTMENT_TYPE_IDS = Object.freeze(Object.keys(ADJUSTMENT_TYPES));
export const sumLines = (lines) => (Array.isArray(lines) ? lines : []).reduce((t, l) => t + int(l.amount), 0);
export const amountAfter = (lines, adjustments) => Math.max(0, sumLines(lines) - sumLines(adjustments));

// The lines of one bill: the access charge, the add-ons for the months it
// covers, and the one-time setup fee when `setup` (the first Distributor bill).
export function billLines(sub, { prepaid = false, setup = false, planName = null } = {}) {
  const f = billFigures(sub, { prepaid });
  if (f.amount === null) return [];
  const type = BILLING_TYPE_IDS.includes(sub?.billingType) ? sub.billingType : "monthly";
  const base = type === "monthly" ? (prepaid && sub.prepaidTerm ? sub.prepaidTerm.price : Number.isSafeInteger(sub.priceOverride) ? sub.priceOverride : int(sub.amount ?? sub.monthlyAmount)) : Number.isSafeInteger(sub.priceOverride) ? sub.priceOverride : int(sub.amount);
  const what = type === "monthly" && f.months === 1 ? "Monthly access" : `${f.months}-month access`;
  const lines = [{ kind: "base", label: `${planName ? `${planName} · ` : ""}${what}${Number.isSafeInteger(sub.priceOverride) && !(prepaid && sub.prepaidTerm) ? " (agreed price)" : ""}`, amount: base }];
  for (const a of Array.isArray(sub.addOns) ? sub.addOns : []) if (a?.flat !== true) lines.push({ kind: "addon", addOnId: a.id, label: `${a.qty} × ${a.label}`, amount: addOnAmount([a], f.months) });
  if (setup && int(sub.setupFee) > 0) lines.push({ kind: "setup", label: "One-time setup fee", amount: int(sub.setupFee) });
  return lines;
}
// Does the next bill of this subscription carry the one-time setup fee?
export const owesSetupFee = (sub) => BILLING_TYPE_IDS.includes(sub?.billingType) && int(sub.setupFee) > 0 && sub.setupFeeBilled !== true;
// A free trial that hasn't chosen a plan yet: nothing is due or billed.
export const awaitingConversion = (sub) => trialOpen(sub) && !sub.conversion;

// The terms of a stored subscription. Older businesses without billing
// fields read as monthly from their creation day (read-only: nothing is
// written back).
export function subscriptionTerms(sub = {}, { createdDay = null } = {}) {
  const type = BILLING_TYPE_IDS.includes(sub.billingType) ? sub.billingType : "monthly";
  const startDate = isDayString(sub.startDate) ? sub.startDate : createdDay;
  const termMonths = Number.isSafeInteger(sub.termMonths) ? sub.termMonths : type === "monthly" ? 1 : 12;
  const paidThrough = isDayString(sub.paidThrough) ? sub.paidThrough : null;
  // The next payment is due the day after what's paid, else on the start
  // date; an operator's changed due date wins.
  const nextDue = isDayString(sub.dueDate) ? sub.dueDate : paidThrough ? shiftDay(paidThrough, 1) : startDate;
  const prepaidNext = type === "monthly" && Boolean(sub.prepaidTerm);
  return {
    billingType: type,
    amount: sub.upgradeDue?.amount ?? billFigures(sub, { prepaid: prepaidNext }).amount,
    termMonths: prepaidNext ? sub.prepaidTerm.months : termMonths,
    prepaidNext,
    priceOverride: Number.isSafeInteger(sub.priceOverride) ? sub.priceOverride : null,
    addOns: Array.isArray(sub.addOns) ? sub.addOns : [],
    autoRenew: typeof sub.autoRenew === "boolean" ? sub.autoRenew : type !== "term",
    startDate,
    paidThrough,
    // monthly: next due date. annual: first payment, then the renewal date.
    // term: the one purchase (null once paid: no renewal), or an open
    // upgrade bill (Luna Bridal → Custom: only the difference).
    dueDate: awaitingConversion(sub) ? null : sub.upgradeDue?.dueDate ?? (type === "term" && paidThrough ? null : nextDue),
    awaitingConversion: awaitingConversion(sub),
    upgradeDue: sub.upgradeDue?.amount ? { amount: sub.upgradeDue.amount, invoiceId: sub.upgradeDue.invoiceId ?? null } : null,
    renewal: type === "annual" && Boolean(paidThrough),
    // annual: access until the last day paid; term: access ends.
    accessUntil: type === "term" ? (isDayString(sub.accessUntil) ? sub.accessUntil : startDate ? shiftDay(addMonths(startDate, termMonths), -1) : null) : type === "annual" ? paidThrough : null,
    extended: sub.extended === true,
  };
}

// What needs attention, with the date that matters (null: nothing soon).
// "Soon": a week for monthly bills and short trials, 30 days for a year.
export const SOON = Object.freeze({ monthly: 7, annual: 30, term: 30 });
const soonFor = (t) => (t.billingType === "annual" && t.termMonths < 12 ? 7 : SOON[t.billingType]);
// `trial` (shared/trial.js trialState): an unconverted free trial shows its
// end ("Trial ends soon" a week before, then "Trial ended") instead of bills.
export const TRIAL_SOON_DAYS = 7;
export function attentionOf(terms, { status = "active", today, trial = null } = {}) {
  if (!terms || !today || ["cancelled", "deleted"].includes(status)) return null;
  if (trial?.open && !trial.conversion) {
    if (trial.ended) return { kind: "trial_ended", date: trial.endsAt, days: -trial.daysLeft, label: "Trial ended", what: "Trial ended", tone: "danger" };
    if (trial.daysLeft <= TRIAL_SOON_DAYS) return { kind: "trial", date: trial.endsAt, days: trial.daysLeft, label: trial.daysLeft === 0 ? "Trial ends today" : "Trial ends soon", what: "Trial ends", tone: "warning" };
    return null;
  }
  const t = terms.billingType;
  const due = terms.dueDate;
  if (due) {
    const left = daysUntil(today, due);
    const what = terms.upgradeDue ? "Upgrade due" : t === "annual" ? (terms.renewal ? "Renewal due" : "Payment due") : t === "term" ? "Payment due" : "Due";
    if (left < 0) return { kind: "overdue", date: due, days: -left, label: `${-left} day${left === -1 ? "" : "s"} overdue`, what, tone: "danger" };
    if (left <= soonFor(terms)) return { kind: "due", date: due, days: left, label: left === 0 ? "Due today" : "Due soon", what, tone: "warning" };
  }
  if (t === "term" && terms.accessUntil) {
    const left = daysUntil(today, terms.accessUntil);
    if (left < 0) return { kind: "expired", date: terms.accessUntil, days: -left, label: "Expired", what: "Access ended", tone: "danger" };
    if (left <= SOON.term) return { kind: "expiring", date: terms.accessUntil, days: left, label: "Expiring soon", what: "Access ends", tone: "warning" };
  }
  return null;
}

// The status word for a subscription row: Bridal never uses Past Due.
export function accessState(terms, { status = "active", today, trial = null } = {}) {
  if (["suspended", "cancelled", "deleted"].includes(status)) return status;
  if (trial?.open && !trial.conversion) return trial.ended ? "trial_ended" : "trial";
  if (terms?.billingType === "term" && terms.accessUntil && today) {
    const left = daysUntil(today, terms.accessUntil);
    if (left < 0) return "expired";
    if (left <= SOON.term) return "expiring";
    if (terms.extended) return "extended";
    return "active";
  }
  return status;
}
