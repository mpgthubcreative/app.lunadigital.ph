// Luna subscription billing, server side (Phase 18.6). See shared/billing.js
// for the model. Everything here is platform-level: tenants reach it only
// through /api/subscription (their own business, Owner only) and operators
// through /api/operator. Every money transition is one transaction with an
// idempotent guard and an audit record; nothing is ever deleted.

import { createHash, randomBytes } from "node:crypto";
import { BillingError, BILLING_SCHEMA_VERSION, BILLING_TIMEZONE, BILLABLE_STATUSES, invoiceId, periodOfDay, periodEnd, dayAfter, dueDateOf, nextPeriod, validatePaymentSubmission, checkProof, validateRejectReason, validateBillingSettings, PAYMENT_STATUSES } from "../../../shared/billing.js";
import { businessDate } from "../../../shared/metrics.js";
import { subscriptionTerms, coverEnd, billFigures, billLines, owesSetupFee, sumLines, amountAfter, isDayString, BILLING_TYPES, ADJUSTMENT_TYPES, ADJUSTMENT_TYPE_IDS } from "../../../shared/plan-billing.js";
import { tenantDb } from "./tenant-db.js";
import { prepareNotifications } from "./notifications.js";

const TX = { maxAttempts: 10 };
const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const peso = (c) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const currentPeriod = (now = new Date()) => periodOfDay(businessDate(BILLING_TIMEZONE, now));

const invoices = (db) => db.collection("subscriptionInvoices");
const payments = (db) => db.collection("subscriptionPayments");
const metricsRef = (db, id) => db.collection("platformMetrics").doc(id);
const settingsRef = (db) => db.collection("platform").doc("billingSettings");
const audit = (db) => db.collection("platformAudit").doc();
const PROOF_PREFIX = (businessId) => `platformBilling/${businessId}/`;

// ---------- Invoices ----------

// The bill a subscription has for `period` (YYYY-MM), from its billing
// terms (shared/plan-billing.js), or null:
//   monthly  every month, due on the start day of the month (businesses
//            from before billing types: the 7th), never before the start
//            and never for a month already paid. A prepaid term (the
//            3-month starter) is ONE bill covering its months, then monthly.
//   annual   the month the first payment / the renewal is due, covering
//            the chosen term (1, 3 or 12 months)
//   term     the month of the one purchase (no renewal)
// The amount is the subscription's price SNAPSHOT (or Super Admin's price
// override) plus its add-ons for the months covered, plus the one-time
// setup fee on a Distributor's first bill; `lines` is that breakdown.
export function billFor(business, period, { setup = null } = {}) {
  const sub = business.subscription || {};
  const created = business.createdAt?.toDate ? businessDate(BILLING_TIMEZONE, business.createdAt.toDate()) : null;
  const t = subscriptionTerms({ ...sub, upgradeDue: null }, { createdDay: created });
  const planName = business.entitlements?.planName ?? null;
  const withLines = (bill, prepaid = false) => {
    if (!bill || !isDayString(sub.startDate) || !sub.billingType) return bill;
    const fee = setup ?? owesSetupFee(sub);
    const lines = billLines(sub, { prepaid, setup: fee, planName });
    return { ...bill, lines, setup: fee && lines.some((l) => l.kind === "setup"), amountDue: sumLines(lines) };
  };
  if (t.billingType === "monthly") {
    const anchored = isDayString(sub.startDate);
    if (!anchored) {
      const amountDue = Number.isSafeInteger(sub.monthlyAmount) ? sub.monthlyAmount : null;
      return amountDue ? { billingType: "monthly", dueDate: dueDateOf(period), amountDue, months: 1, coverFrom: `${period}-01`, coverTo: periodEnd(period) } : null;
    }
    if (period < periodOfDay(sub.startDate)) return null;
    // The prepaid term: one bill on the next due date, covering its months.
    if (t.prepaidNext && t.dueDate) {
      const cover = coverEnd(t.dueDate, t.termMonths);
      if (period === periodOfDay(t.dueDate)) {
        const f = billFigures(sub, { prepaid: true });
        return f.amount ? withLines({ billingType: "monthly", dueDate: t.dueDate, amountDue: f.amount, months: f.months, prepaid: true, coverFrom: t.dueDate, coverTo: cover }, true) : null;
      }
      if (period > periodOfDay(t.dueDate) && period <= periodOfDay(cover)) return null;
    }
    const day = Math.min(Number(sub.startDate.slice(8)), Number(periodEnd(period).slice(8)));
    const dueDate = `${period}-${String(day).padStart(2, "0")}`;
    if (t.paidThrough && dueDate <= t.paidThrough) return null;
    const f = billFigures(sub);
    return f.amount ? withLines({ billingType: "monthly", dueDate, amountDue: f.amount, months: 1, coverFrom: dueDate, coverTo: coverEnd(dueDate, 1) }) : null;
  }
  if (!t.dueDate || periodOfDay(t.dueDate) !== period) return null;
  const f = billFigures(sub);
  return f.amount ? withLines({ billingType: t.billingType, dueDate: t.dueDate, amountDue: f.amount, months: f.months, coverFrom: t.dueDate, coverTo: t.billingType === "term" ? t.accessUntil ?? coverEnd(t.dueDate, f.months) : coverEnd(t.dueDate, f.months) }) : null;
}

// Inside a transaction (after the caller's reads): creates the period's
// invoice for a billed subscription if it doesn't exist yet; "still to
// collect" grows by it. `existing` is the already-read invoice snapshot.
function planInvoice(tx, { db, FieldValue, businessId, business, period, existing }) {
  if (existing.exists) return existing.data();
  const sub = business.subscription || {};
  if (!BILLABLE_STATUSES.includes(sub.status)) return null;
  const bill = billFor(business, period);
  if (!bill) return null;
  // A waived setup fee still shows: the fee, then "Setup fee waived".
  const adjustments = bill.setup && sub.setupFeeWaived ? [{ id: "setup-waived", type: "setup_waived", description: "Setup fee waived", amount: sub.setupFee }] : [];
  const amountDue = bill.lines ? amountAfter(bill.lines, adjustments) : bill.amountDue;
  const inv = {
    schemaVersion: BILLING_SCHEMA_VERSION,
    businessId,
    businessName: business.name ?? businessId,
    workspaceTemplateId: business.workspaceTemplateId ?? null,
    planId: sub.planId ?? null,
    planName: business.entitlements?.planName ?? sub.planId ?? null,
    period,
    billingType: bill.billingType,
    dueDate: bill.dueDate,
    coverFrom: bill.coverFrom,
    coverTo: bill.coverTo,
    months: bill.months,
    ...(bill.prepaid ? { prepaid: true } : {}),
    ...(bill.lines ? { lines: bill.lines, adjustments } : {}),
    amountDue,
    amountPaid: 0,
    status: "due",
    paymentIds: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  tx.create(invoices(db).doc(invoiceId(businessId, period)), inv);
  // The one-time setup fee is billed once: never on a later bill.
  if (bill.setup) {
    tx.update(db.collection("businesses").doc(businessId), { "subscription.setupFeeBilled": true });
    tx.set(audit(db), { type: sub.setupFeeWaived ? "billing.setup-fee-waived" : "billing.setup-fee-billed", summary: `Setup fee ${peso(sub.setupFee)} ${sub.setupFeeWaived ? "billed and waived" : "billed"} on the ${period} bill`, businessId, amount: sub.setupFee, invoiceId: invoiceId(businessId, period), actor: "luna-billing", at: FieldValue.serverTimestamp() });
  }
  tx.set(metricsRef(db, period), { period, amountInvoiced: FieldValue.increment(amountDue), invoicesCreated: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  tx.set(metricsRef(db, "current"), { outstanding: FieldValue.increment(amountDue), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return inv;
}

// One business's invoice for a month (created if billable and missing).
export async function ensureInvoice({ db, FieldValue, businessId, period }) {
  return db.runTransaction(async (tx) => {
    const [b, inv] = await Promise.all([tx.get(db.collection("businesses").doc(businessId)), tx.get(invoices(db).doc(invoiceId(businessId, period)))]);
    if (!b.exists) throw new BillingError("not-found", "Business not found");
    return planInvoice(tx, { db, FieldValue, businessId, business: b.data(), period, existing: inv });
  }, TX);
}

// The monthly billing run: every billed subscription gets the month's
// invoice, once (platformMetrics/{period}.invoicesGenerated). Safe to call
// on every Super Luna load: after the first run it only reads one document.
export async function billingRun({ db, FieldValue, period }) {
  const m = await metricsRef(db, period).get();
  if (m.exists && m.data().invoicesGenerated === true) return { ran: false };
  const snap = await db.collection("businesses").where("subscription.status", "in", BILLABLE_STATUSES).get();
  let created = 0;
  for (const d of snap.docs) {
    const before = await invoices(db).doc(invoiceId(d.id, period)).get();
    if (before.exists) continue;
    if (await ensureInvoice({ db, FieldValue, businessId: d.id, period })) created += 1;
  }
  await metricsRef(db, period).set({ period, invoicesGenerated: true, invoicesGeneratedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ran: true, created };
}

// ---------- Settings ----------

export async function getBillingSettings({ db }) {
  const s = await settingsRef(db).get();
  if (!s.exists) return null;
  const { bankName, accountName, accountNumber, instructions, updatedAt } = s.data();
  return { bankName, accountName, accountNumber, instructions: instructions ?? null, updatedAt: updatedAt?.toDate?.().toISOString?.() ?? null };
}

export async function setBillingSettings({ db, FieldValue, input, actor }) {
  const next = validateBillingSettings(input);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(settingsRef(db));
    const before = s.exists ? s.data() : null;
    tx.set(settingsRef(db), { ...next, schemaVersion: BILLING_SCHEMA_VERSION, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
    tx.set(audit(db), { type: "billing.settings-changed", actor, before: before ? { bankName: before.bankName, accountName: before.accountName, accountNumber: before.accountNumber } : null, after: { bankName: next.bankName, accountName: next.accountName, accountNumber: next.accountNumber }, at: FieldValue.serverTimestamp() });
    return { saved: true };
  }, TX);
}

// ---------- Tenant view ----------

const iso = (ts) => ts?.toDate?.().toISOString?.() ?? null;
function paymentView(p, id) {
  return {
    id,
    period: p.period,
    amountDue: p.amountDue,
    amountSubmitted: p.amountSubmitted,
    paymentDate: p.paymentDate,
    method: p.method,
    reference: p.reference,
    status: p.status,
    statusLabel: PAYMENT_STATUSES[p.status]?.label ?? p.status,
    submittedAt: iso(p.submittedAt),
    verifiedAt: iso(p.verifiedAt),
    rejectedAt: iso(p.rejectedAt),
    rejectionReason: p.rejectionReason ?? null,
    hasProof: Boolean(p.proof?.path),
  };
}
// A bill as people see it: its breakdown (lines, then what's taken off).
export const invoiceView = (i, id = null) => (i ? { id: id ?? invoiceId(i.businessId, i.period), kind: i.kind ?? "access", period: i.period, dueDate: i.dueDate, planName: i.planName, lines: i.lines ?? [{ kind: "base", label: i.planName ?? "Subscription", amount: i.amountDue }], adjustments: i.adjustments ?? [], amountDue: i.amountDue, amountPaid: i.amountPaid, balance: Math.max(0, i.amountDue - i.amountPaid), status: i.status, editable: isEditable(i) } : null);
// Discounts / credits can change only before any money is recorded on the bill.
const isEditable = (i) => i.status === "due" && int(i.amountPaid) === 0;

// What the Owner's Subscription page shows (own business only).
export async function tenantSubscription({ db, FieldValue, businessId, now = new Date() }) {
  const period = currentPeriod(now);
  await ensureInvoice({ db, FieldValue, businessId, period }).catch((err) => {
    if (!(err instanceof BillingError)) throw err;
  });
  const [b, inv, open, hist, settings] = await Promise.all([
    db.collection("businesses").doc(businessId).get(),
    invoices(db).doc(invoiceId(businessId, period)).get(),
    invoices(db).where("businessId", "==", businessId).where("status", "in", ["due", "for_verification"]).get(),
    payments(db).where("businessId", "==", businessId).orderBy("submittedAt", "desc").limit(24).get(),
    getBillingSettings({ db }),
  ]);
  const business = b.data();
  const sub = business.subscription || {};
  const created = business.createdAt?.toDate ? businessDate(BILLING_TIMEZONE, business.createdAt.toDate()) : null;
  const terms = subscriptionTerms(sub, { createdDay: created });
  return {
    plan: { id: sub.planId, name: business.entitlements?.planName ?? sub.planId },
    // How this plan is billed: monthly, annual access or 12-month access.
    billing: { type: terms.billingType, amount: terms.amount, termMonths: terms.termMonths, dueDate: terms.dueDate, renewal: terms.renewal, accessUntil: terms.accessUntil, autoRenew: terms.autoRenew, addOns: terms.addOns.map((a) => ({ label: a.label, qty: a.qty })) },
    status: sub.status,
    monthlyAmount: sub.monthlyAmount ?? null,
    paidThrough: sub.paidThrough ?? null,
    nextRenewal: sub.nextRenewal ?? null,
    current: invoiceView(inv.exists ? inv.data() : null, inv.id),
    openInvoices: open.docs.map((d) => invoiceView(d.data(), d.id)).sort((a, b) => (a.period < b.period ? -1 : 1)),
    payments: hist.docs.map((d) => paymentView(d.data(), d.id)),
    instructions: settings,
  };
}

// ---------- Submit (tenant Owner) ----------

const paymentIdFor = (businessId, key) => `sp${createHash("sha256").update(`${businessId}:${key}`).digest("hex").slice(0, 30)}`;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;

export async function submitPayment({ db, bucket, FieldValue, businessId, actor, input, proof, idempotencyKey, now = new Date() }) {
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new BillingError("invalid-input", "Invalid request key");
  const today = businessDate(BILLING_TIMEZONE, now);
  // Proof: a screenshot / receipt OR a reference number (one is enough).
  const hasProof = Boolean(proof && typeof proof === "object" && typeof proof.dataBase64 === "string" && proof.dataBase64);
  const data = validatePaymentSubmission(input, { today, hasProof });
  const bytes = hasProof ? Buffer.from(proof.dataBase64, "base64") : null;
  const ext = hasProof ? checkProof(bytes, proof.contentType) : null;
  const paymentId = paymentIdFor(businessId, idempotencyKey);
  const payRef = payments(db).doc(paymentId);
  if (data.invoiceId && !data.invoiceId.startsWith(`${businessId}_`)) throw new BillingError("no-invoice", "There's no such bill");
  const invRef = invoices(db).doc(data.invoiceId ?? invoiceId(businessId, data.period));

  const prior = await payRef.get();
  if (prior.exists) return { paymentId, alreadySubmitted: true, status: prior.data().status };
  let first = await invRef.get();
  // The month's bill may not exist yet (nobody opened Subscription since the
  // month began): make it, never for a future month.
  if (!first.exists && data.period <= currentPeriod(now)) {
    await ensureInvoice({ db, FieldValue, businessId, period: data.period });
    first = await invRef.get();
  }
  if (!first.exists) throw new BillingError("no-invoice", "There's no bill for that month");
  if (first.data().status === "paid") throw new BillingError("already-paid", "That month is already paid");

  // Luna's billing file: stored by the server, private, not tenant storage.
  const path = hasProof ? `${PROOF_PREFIX(businessId)}${paymentId}-${randomBytes(4).toString("hex")}.${ext}` : null;
  if (hasProof) await (await bucket()).file(path).save(bytes, { resumable: false, contentType: proof.contentType, metadata: { metadata: { businessId, paymentId, uploadedBy: actor.uid } } });
  try {
    const result = await db.runTransaction(async (tx) => {
      const [p, inv, b] = await Promise.all([tx.get(payRef), tx.get(invRef), tx.get(db.collection("businesses").doc(businessId))]);
      if (p.exists) return { paymentId, alreadySubmitted: true, status: p.data().status, orphan: path };
      const i = inv.data();
      if (i.status === "paid") throw new BillingError("already-paid", "That month is already paid");
      const tenant = tenantDb(db, businessId);
      const notify = await prepareNotifications(tx, { tenant, actor, events: [{ type: "billing.payment_update", key: `submitted-${paymentId}`, title: `Payment sent for ${i.period}`, message: `${peso(data.amount)} by bank transfer${data.reference ? ` (ref ${data.reference})` : ""}. Luna will confirm it.`, recordType: "subscriptionPayment", recordId: paymentId }] });
      const stamp = FieldValue.serverTimestamp();
      tx.create(payRef, {
        schemaVersion: BILLING_SCHEMA_VERSION,
        businessId,
        businessName: b.data().name ?? businessId,
        workspaceTemplateId: i.workspaceTemplateId,
        planId: i.planId,
        planNameSnapshot: i.planName,
        period: i.period,
        invoiceId: inv.id,
        amountDue: i.amountDue,
        amountSubmitted: data.amount,
        method: data.method,
        paymentDate: data.paymentDate,
        reference: data.reference,
        note: data.note,
        proof: hasProof ? { path, contentType: proof.contentType, size: bytes.length } : null,
        status: "for_verification",
        submittedBy: actor,
        submittedAt: stamp,
        verifiedBy: null,
        verifiedAt: null,
        rejectedBy: null,
        rejectedAt: null,
        rejectionReason: null,
        updatedAt: stamp,
      });
      tx.update(invRef, { status: "for_verification", paymentIds: [...(i.paymentIds || []), paymentId], updatedAt: stamp });
      tx.set(metricsRef(db, "current"), { awaitingCount: FieldValue.increment(1), awaitingAmount: FieldValue.increment(data.amount), updatedAt: stamp }, { merge: true });
      tx.set(tenant.collection("auditLog").doc(), { type: "subscription.payment-submitted", paymentId, period: i.period, invoiceId: inv.id, amount: data.amount, reference: data.reference, actor, at: stamp });
      tx.set(audit(db), { type: "subscription.payment-submitted", businessId, paymentId, period: i.period, invoiceId: inv.id, amount: data.amount, actor: actor.email || actor.uid, at: stamp });
      notify.commit({ FieldValue });
      return { paymentId, status: "for_verification" };
    }, TX);
    // A concurrent identical submit won: this upload isn't referenced.
    if (result.orphan && path) {
      await (await bucket()).file(result.orphan).delete().catch(() => {});
      delete result.orphan;
    }
    return result;
  } catch (err) {
    if (path) await (await bucket()).file(path).delete().catch(() => {});
    throw err;
  }
}

// ---------- Confirm / reject (operator) ----------

// Confirm: the money arrived. Idempotent: a payment already decided changes
// nothing (no second credit, renewal or revenue count, no second audit).
export async function confirmPayment({ db, FieldValue, paymentId, operator, now = new Date() }) {
  const payRef = payments(db).doc(paymentId);
  return db.runTransaction(async (tx) => {
    const p = await tx.get(payRef);
    if (!p.exists) throw new BillingError("not-found", "Payment not found");
    const pay = p.data();
    if (pay.status !== "for_verification") return { paymentId, alreadyDecided: true, status: pay.status };
    const invRef = invoices(db).doc(pay.invoiceId);
    const bizRef = db.collection("businesses").doc(pay.businessId);
    const [inv, b] = await Promise.all([tx.get(invRef), tx.get(bizRef)]);
    const i = inv.data();
    const business = b.data();
    const tenant = tenantDb(db, pay.businessId);
    const amount = pay.amountSubmitted;
    const amountPaid = i.amountPaid + amount;
    const fullyPaid = amountPaid >= i.amountDue;
    const otherPending = (i.paymentIds || []).filter((id) => id !== paymentId);
    let pendingLeft = false;
    for (const id of otherPending) {
      const o = await tx.get(payments(db).doc(id));
      if (o.exists && o.data().status === "for_verification") pendingLeft = true;
    }
    const notify = await prepareNotifications(tx, { tenant, events: [{ type: "billing.payment_update", key: `confirmed-${paymentId}`, title: `Payment confirmed for ${pay.period}`, message: `Luna received ${peso(amount)}. ${fullyPaid ? `${pay.period} is paid.` : `${peso(i.amountDue - amountPaid)} is still due for ${pay.period}.`}`, recordType: "subscriptionPayment", recordId: paymentId }] });
    const stamp = FieldValue.serverTimestamp();
    const verifiedMonth = currentPeriod(now);
    const sub = business.subscription || {};
    const before = { status: sub.status, paidThrough: sub.paidThrough ?? null, nextRenewal: sub.nextRenewal ?? null };
    const subChanges = {};
    if (fullyPaid) {
      // What the bill covers (its billing type's term), else the month.
      const end = i.coverTo || periodEnd(i.period);
      const paidThrough = sub.paidThrough && sub.paidThrough > end ? sub.paidThrough : end;
      subChanges["subscription.paidThrough"] = paidThrough;
      subChanges["subscription.nextRenewal"] = dayAfter(paidThrough);
      // An operator's changed due date is settled by the payment.
      if (sub.dueDate) subChanges["subscription.dueDate"] = null;
      // A paid prepaid term (Distributor 3-month starter) is used up: monthly from here.
      if (i.prepaid && sub.prepaidTerm) subChanges["subscription.prepaidTerm"] = null;
      // A paid upgrade bill (Luna Bridal → Custom) closes; access dates stay.
      if (i.kind === "upgrade" && sub.upgradeDue?.invoiceId === invRef.id) subChanges["subscription.upgradeDue"] = null;
      // A paid bill brings a past-due subscription back; a suspension stays
      // the operator's own decision.
      if (sub.status === "past_due") subChanges["subscription.status"] = "active";
    }
    tx.update(payRef, { status: "paid", amountReceived: amount, verifiedBy: operator, verifiedAt: stamp, updatedAt: stamp });
    tx.update(invRef, { amountPaid, status: fullyPaid ? "paid" : pendingLeft ? "for_verification" : "due", paidAt: fullyPaid ? stamp : null, updatedAt: stamp });
    // 12-month access: what's been paid toward it (an upgrade charges only the difference).
    if ((i.billingType || sub.billingType) === "term") subChanges["subscription.accessPaid"] = FieldValue.increment(amount);
    if (Object.keys(subChanges).length) tx.update(bizRef, { ...subChanges, updatedAt: stamp });
    const ws = pay.workspaceTemplateId || "unknown";
    // Revenue by workspace, plan and billing type (recurring monthly vs
    // annual / 12-month access): Bridal is never counted as monthly income.
    const btype = i.billingType || sub.billingType || "monthly";
    tx.set(metricsRef(db, verifiedMonth), { period: verifiedMonth, verifiedRevenue: FieldValue.increment(amount), paymentsVerified: FieldValue.increment(1), revenueByWorkspace: { [ws]: FieldValue.increment(amount) }, revenueByPlan: { [pay.planId || "unknown"]: FieldValue.increment(amount) }, revenueByBillingType: { [btype]: FieldValue.increment(amount) }, updatedAt: stamp }, { merge: true });
    tx.set(metricsRef(db, "current"), { awaitingCount: FieldValue.increment(-1), awaitingAmount: FieldValue.increment(-amount), outstanding: FieldValue.increment(-Math.min(amount, Math.max(0, i.amountDue - i.amountPaid))), updatedAt: stamp }, { merge: true });
    const after = { status: subChanges["subscription.status"] ?? sub.status, paidThrough: subChanges["subscription.paidThrough"] ?? before.paidThrough, nextRenewal: subChanges["subscription.nextRenewal"] ?? before.nextRenewal };
    tx.set(audit(db), { type: "subscription.payment-confirmed", businessId: pay.businessId, paymentId, period: pay.period, amount, actor: operator, before, after, at: stamp });
    tx.set(tenant.collection("auditLog").doc(), { type: "subscription.payment-confirmed", paymentId, period: pay.period, amount, actor: { name: "Luna", operator }, before, after, at: stamp });
    notify.commit({ FieldValue });
    return { paymentId, status: "paid", invoiceStatus: fullyPaid ? "paid" : "due", paidThrough: after.paidThrough, nextRenewal: after.nextRenewal, verifiedMonth };
  }, TX);
}

// Reject: the tenant sees the reason and can send a corrected proof. The
// submission stays in the history.
export async function rejectPayment({ db, FieldValue, paymentId, reason, operator }) {
  const why = validateRejectReason(reason);
  const payRef = payments(db).doc(paymentId);
  return db.runTransaction(async (tx) => {
    const p = await tx.get(payRef);
    if (!p.exists) throw new BillingError("not-found", "Payment not found");
    const pay = p.data();
    if (pay.status !== "for_verification") return { paymentId, alreadyDecided: true, status: pay.status };
    const invRef = invoices(db).doc(pay.invoiceId);
    const inv = await tx.get(invRef);
    const i = inv.data();
    let pendingLeft = false;
    for (const id of (i.paymentIds || []).filter((x) => x !== paymentId)) {
      const o = await tx.get(payments(db).doc(id));
      if (o.exists && o.data().status === "for_verification") pendingLeft = true;
    }
    const tenant = tenantDb(db, pay.businessId);
    const notify = await prepareNotifications(tx, { tenant, events: [{ type: "billing.payment_update", key: `rejected-${paymentId}`, title: `Payment for ${pay.period} not accepted`, message: `Reason: ${why}. You can send a corrected payment proof from Subscription.`, recordType: "subscriptionPayment", recordId: paymentId }] });
    const stamp = FieldValue.serverTimestamp();
    tx.update(payRef, { status: "rejected", rejectedBy: operator, rejectedAt: stamp, rejectionReason: why, updatedAt: stamp });
    tx.update(invRef, { status: i.amountPaid >= i.amountDue ? "paid" : pendingLeft ? "for_verification" : "due", updatedAt: stamp });
    tx.set(metricsRef(db, "current"), { awaitingCount: FieldValue.increment(-1), awaitingAmount: FieldValue.increment(-pay.amountSubmitted), updatedAt: stamp }, { merge: true });
    tx.set(audit(db), { type: "subscription.payment-rejected", businessId: pay.businessId, paymentId, period: pay.period, amount: pay.amountSubmitted, reason: why, actor: operator, at: stamp });
    tx.set(tenant.collection("auditLog").doc(), { type: "subscription.payment-rejected", paymentId, period: pay.period, reason: why, actor: { name: "Luna", operator }, at: stamp });
    notify.commit({ FieldValue });
    return { paymentId, status: "rejected" };
  }, TX);
}

// The proof image / PDF for an operator (inline, never a public URL).
export async function readPaymentProof({ db, bucket, paymentId }) {
  const p = await payments(db).doc(paymentId).get();
  const proof = p.exists ? p.data().proof : null;
  if (!proof || typeof proof.path !== "string" || !proof.path.startsWith(PROOF_PREFIX(p.data().businessId))) throw new BillingError("not-found", "No proof on this payment");
  const [data] = await (await bucket()).file(proof.path).download();
  return { contentType: proof.contentType, dataBase64: data.toString("base64") };
}

// ---------- Operator: record a payment, change a date, remind ----------

// Luna records a payment it received outside the app (cash, a transfer the
// business didn't upload): the bill for the subscription's next due date
// is created if needed, then the payment is confirmed like any other
// (credits the period, moves the dates, counts the revenue, once).
export async function recordOperatorPayment({ db, FieldValue, businessId, input, operator, now = new Date() }) {
  const today = businessDate(BILLING_TIMEZONE, now);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BillingError("invalid-input", "Invalid payment");
  for (const k of Object.keys(input)) if (!["amount", "paymentDate", "reference", "note"].includes(k)) throw new BillingError("invalid-input", `Field ${k} can't be set`);
  if (!isDayString(input.paymentDate) || input.paymentDate > today) throw new BillingError("invalid-input", "Choose the date it was paid (not in the future)");
  const reference = typeof input.reference === "string" && input.reference.trim() ? input.reference.trim().slice(0, 80) : "Recorded by Luna";
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 300) : null;
  const bizRef = db.collection("businesses").doc(businessId);
  const b = await bizRef.get();
  if (!b.exists) throw new BillingError("not-found", "Business not found");
  const business = b.data();
  const created = business.createdAt?.toDate ? businessDate(BILLING_TIMEZONE, business.createdAt.toDate()) : null;
  const terms = subscriptionTerms(business.subscription || {}, { createdDay: created });
  const due = terms.dueDate;
  if (!due) throw new BillingError("already-paid", "Nothing is due: this access is already paid");
  const period = periodOfDay(due);
  const upgradeId = business.subscription?.upgradeDue?.invoiceId ?? null;
  const invRef = invoices(db).doc(upgradeId ?? invoiceId(businessId, period));
  await db.runTransaction(async (tx) => {
    const inv = await tx.get(invRef);
    if (inv.exists) return;
    if (upgradeId) throw new BillingError("no-invoice", "The upgrade bill is missing");
    const bill = billFor(business, period);
    if (!bill) throw new BillingError("no-invoice", "There's no bill for that date");
    planInvoice(tx, { db, FieldValue, businessId, business: { ...business, subscription: { ...business.subscription, status: BILLABLE_STATUSES.includes(business.subscription?.status) ? business.subscription.status : "active" } }, period, existing: inv });
  }, TX);
  const inv = (await invRef.get()).data();
  if (inv.status === "paid") throw new BillingError("already-paid", "That bill is already paid");
  const balance = inv.amountDue - inv.amountPaid;
  const amount = input.amount === undefined ? balance : input.amount;
  // A bill brought to ₱0 by discounts / credits is settled with a ₱0 record.
  if (!Number.isSafeInteger(amount) || amount < 0 || (amount === 0 && balance > 0)) throw new BillingError("invalid-input", "Amount must be more than ₱0");
  const paymentId = `sp${createHash("sha256").update(`${businessId}:recorded:${period}:${inv.paymentIds?.length ?? 0}:${input.paymentDate}:${amount}`).digest("hex").slice(0, 30)}`;
  const payRef = payments(db).doc(paymentId);
  await db.runTransaction(async (tx) => {
    const [p, i] = await Promise.all([tx.get(payRef), tx.get(invRef)]);
    if (p.exists) return;
    const stamp = FieldValue.serverTimestamp();
    tx.create(payRef, { schemaVersion: BILLING_SCHEMA_VERSION, businessId, businessName: business.name ?? businessId, workspaceTemplateId: i.data().workspaceTemplateId, planId: i.data().planId, planNameSnapshot: i.data().planName, period: i.data().period, invoiceId: invRef.id, amountDue: i.data().amountDue, amountSubmitted: amount, method: "recorded", paymentDate: input.paymentDate, reference, note, proof: null, status: "for_verification", submittedBy: { name: "Luna", email: operator }, submittedAt: stamp, verifiedBy: null, verifiedAt: null, rejectedBy: null, rejectedAt: null, rejectionReason: null, updatedAt: stamp });
    tx.update(invRef, { paymentIds: [...(i.data().paymentIds || []), paymentId], updatedAt: stamp });
    tx.set(metricsRef(db, "current"), { awaitingCount: FieldValue.increment(1), awaitingAmount: FieldValue.increment(amount), updatedAt: stamp }, { merge: true });
  }, TX);
  return confirmPayment({ db, FieldValue, paymentId, operator, now });
}

// The date that matters for this billing type: the next due date (monthly
// and annual) or the access end (12-month access: a later end = Extended).
export async function setBillingDate({ db, FieldValue, businessId, date, reason, operator }) {
  if (!isDayString(date)) throw new BillingError("invalid-input", "Choose a date");
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3) throw new BillingError("reason-required", "Give a reason (it's recorded)");
  const ref = db.collection("businesses").doc(businessId);
  return db.runTransaction(async (tx) => {
    const b = await tx.get(ref);
    if (!b.exists) throw new BillingError("not-found", "Business not found");
    const business = b.data();
    const created = business.createdAt?.toDate ? businessDate(BILLING_TIMEZONE, business.createdAt.toDate()) : null;
    const t = subscriptionTerms(business.subscription || {}, { createdDay: created });
    const term = t.billingType === "term" && t.paidThrough;
    const field = term ? "accessUntil" : "dueDate";
    const before = term ? t.accessUntil : t.dueDate;
    const changes = { [`subscription.${field}`]: date, ...(term ? { "subscription.extended": Boolean(before && date > before) || business.subscription?.extended === true } : {}), updatedAt: FieldValue.serverTimestamp() };
    tx.update(ref, changes);
    const record = { type: term ? "subscription.access-changed" : "subscription.due-date-changed", summary: term ? `Access end ${before ?? "—"} → ${date}` : `Due date ${before ?? "—"} → ${date}`, businessId, actor: operator, reason: why, before: { [field]: before }, after: { [field]: date }, at: FieldValue.serverTimestamp() };
    tx.set(audit(db), record);
    tx.set(tenantDb(db, businessId).collection("auditLog").doc(), record);
    return { businessId, field, date };
  }, TX);
}

// A billing reminder to the business's owners (in-app notification).
export async function sendBillingReminder({ db, FieldValue, businessId, message = null, operator, now = new Date() }) {
  const b = await db.collection("businesses").doc(businessId).get();
  if (!b.exists) throw new BillingError("not-found", "Business not found");
  const business = b.data();
  const created = business.createdAt?.toDate ? businessDate(BILLING_TIMEZONE, business.createdAt.toDate()) : null;
  const t = subscriptionTerms(business.subscription || {}, { createdDay: created });
  const when = t.dueDate ? `${t.billingType === "annual" && t.renewal ? "Renewal due" : "Payment due"} ${t.dueDate}` : t.accessUntil ? `Access ends ${t.accessUntil}` : "Billing update";
  const text = typeof message === "string" && message.trim() ? message.trim().slice(0, 300) : `${when}. ${t.amount ? `Amount: ${peso(t.amount)}.` : ""} Open Subscription to see how to pay.`.trim();
  const tenant = tenantDb(db, businessId);
  const sent = await db.runTransaction(async (tx) => {
    const notes = await prepareNotifications(tx, { tenant, events: [{ type: "billing.payment_update", key: `reminder-${businessDate(BILLING_TIMEZONE, now)}-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`, title: `Luna ${BILLING_TYPES[t.billingType]?.label.toLowerCase() ?? "subscription"}: ${when}`, message: text, recordType: "subscription", recordId: businessId }] });
    const stamp = FieldValue.serverTimestamp();
    tx.set(audit(db), { type: "subscription.reminder-sent", summary: `Reminder sent: ${when}`, businessId, actor: operator, after: { message: text }, at: stamp });
    return notes.commit({ FieldValue });
  }, TX);
  return { businessId, sent, message: text };
}

// ---------- Bills: breakdown, discounts / credits, re-pricing, upgrade (2026-10-20) ----------

// Every bill of a business, newest first (a handful a year).
export async function businessBills({ db, businessId, max = 12 }) {
  const snap = await invoices(db).where("businessId", "==", businessId).get();
  return snap.docs.map((d) => invoiceView(d.data(), d.id)).sort((a, b) => (a.dueDate < b.dueDate ? 1 : a.dueDate > b.dueDate ? -1 : 0)).slice(0, max);
}

// The bill Super Admin works on: the given one, the open upgrade bill, or
// the bill for the next due date (made now if it doesn't exist yet).
async function targetBill({ db, FieldValue, businessId, invoiceId: id = null }) {
  if (id) {
    if (!id.startsWith(`${businessId}_`)) throw new BillingError("no-invoice", "There's no such bill");
    return invoices(db).doc(id);
  }
  const b = await db.collection("businesses").doc(businessId).get();
  if (!b.exists) throw new BillingError("not-found", "Business not found");
  const sub = b.data().subscription || {};
  if (sub.upgradeDue?.invoiceId) return invoices(db).doc(sub.upgradeDue.invoiceId);
  const created = b.data().createdAt?.toDate ? businessDate(BILLING_TIMEZONE, b.data().createdAt.toDate()) : null;
  const t = subscriptionTerms(sub, { createdDay: created });
  if (!t.dueDate) throw new BillingError("already-paid", "Nothing is due: this access is already paid");
  const period = periodOfDay(t.dueDate);
  await db.runTransaction(async (tx) => {
    const inv = await tx.get(invoices(db).doc(invoiceId(businessId, period)));
    if (inv.exists) return;
    const fresh = await tx.get(db.collection("businesses").doc(businessId));
    const bus = fresh.data();
    const made = planInvoice(tx, { db, FieldValue, businessId, business: { ...bus, subscription: { ...bus.subscription, status: BILLABLE_STATUSES.includes(bus.subscription?.status) ? bus.subscription.status : "active" } }, period, existing: inv });
    if (!made) throw new BillingError("no-invoice", "There's no bill for the next due date");
  }, TX);
  return invoices(db).doc(invoiceId(businessId, period));
}

// Rewrites a bill's amount from its lines and adjustments (before payment),
// keeping "still to collect" and the month's invoiced total in step.
function writeAmount(tx, { db, FieldValue, ref, inv, lines, adjustments, extra = {} }) {
  const amountDue = amountAfter(lines, adjustments);
  const delta = amountDue - inv.amountDue;
  const stamp = FieldValue.serverTimestamp();
  tx.update(ref, { lines, adjustments, amountDue, updatedAt: stamp, ...extra });
  if (delta) {
    tx.set(metricsRef(db, inv.period), { amountInvoiced: FieldValue.increment(delta), updatedAt: stamp }, { merge: true });
    tx.set(metricsRef(db, "current"), { outstanding: FieldValue.increment(delta), updatedAt: stamp }, { merge: true });
  }
  return amountDue;
}

const cleanText = (v, field, max) => {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (!t) throw new BillingError("invalid-input", `${field} is required`);
  if (t.length > max) throw new BillingError("invalid-input", `${field} is too long (max ${max})`);
  return t;
};

// + Add discount / deduction: a line taken off the bill (the plan's price
// never changes). Only before any payment is recorded on it.
export async function addBillAdjustment({ db, FieldValue, businessId, invoiceId: id = null, adjustment, operator }) {
  const a = adjustment && typeof adjustment === "object" && !Array.isArray(adjustment) ? adjustment : {};
  for (const k of Object.keys(a)) if (!["type", "description", "amount"].includes(k)) throw new BillingError("invalid-input", `Field ${k} can't be set`);
  if (!ADJUSTMENT_TYPE_IDS.includes(a.type)) throw new BillingError("invalid-input", "Choose discount, credit / deduction or setup fee waived");
  if (!Number.isSafeInteger(a.amount) || a.amount <= 0 || a.amount > 100_000_000) throw new BillingError("invalid-input", "Amount must be more than ₱0");
  const description = cleanText(a.description ?? ADJUSTMENT_TYPES[a.type].label, "Description", 80);
  const ref = await targetBill({ db, FieldValue, businessId, invoiceId: id });
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new BillingError("no-invoice", "There's no such bill");
    const inv = snap.data();
    if (!isEditable(inv)) throw new BillingError("bill-locked", "This bill already has a payment: its breakdown is kept as it was");
    const lines = inv.lines ?? [{ kind: "base", label: inv.planName ?? "Subscription", amount: inv.amountDue }];
    const entry = { id: `adj${createHash("sha256").update(`${ref.id}:${(inv.adjustments || []).length}:${a.type}:${description}:${a.amount}:${Date.now()}`).digest("hex").slice(0, 12)}`, type: a.type, description, amount: a.amount, addedBy: operator };
    const adjustments = [...(inv.adjustments || []), entry];
    const amountDue = writeAmount(tx, { db, FieldValue, ref, inv, lines, adjustments });
    if (inv.kind === "upgrade") tx.update(db.collection("businesses").doc(businessId), { "subscription.upgradeDue.amount": amountDue });
    const record = { type: "billing.adjustment-added", summary: `${ADJUSTMENT_TYPES[a.type].label} on the ${inv.period} bill: ${description} −${peso(a.amount)} (now ${peso(amountDue)})`, businessId, invoiceId: ref.id, amount: a.amount, actor: operator, after: entry, at: FieldValue.serverTimestamp() };
    tx.set(audit(db), record);
    tx.set(tenantDb(db, businessId).collection("auditLog").doc(), record);
    return { invoiceId: ref.id, adjustmentId: entry.id, amountDue };
  }, TX);
}

export async function removeBillAdjustment({ db, FieldValue, businessId, invoiceId: id, adjustmentId, operator }) {
  if (typeof id !== "string" || !id.startsWith(`${businessId}_`)) throw new BillingError("no-invoice", "There's no such bill");
  const ref = invoices(db).doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new BillingError("no-invoice", "There's no such bill");
    const inv = snap.data();
    if (!isEditable(inv)) throw new BillingError("bill-locked", "This bill already has a payment: its breakdown is kept as it was");
    const gone = (inv.adjustments || []).find((x) => x.id === adjustmentId);
    if (!gone) throw new BillingError("not-found", "That discount / deduction isn't on this bill");
    const adjustments = inv.adjustments.filter((x) => x.id !== adjustmentId);
    const amountDue = writeAmount(tx, { db, FieldValue, ref, inv, lines: inv.lines ?? [], adjustments });
    if (inv.kind === "upgrade") tx.update(db.collection("businesses").doc(businessId), { "subscription.upgradeDue.amount": amountDue });
    const record = { type: "billing.adjustment-removed", summary: `Removed from the ${inv.period} bill: ${gone.description} −${peso(gone.amount)} (now ${peso(amountDue)})`, businessId, invoiceId: ref.id, amount: gone.amount, actor: operator, before: gone, at: FieldValue.serverTimestamp() };
    tx.set(audit(db), record);
    tx.set(tenantDb(db, businessId).collection("auditLog").doc(), record);
    return { invoiceId: ref.id, amountDue };
  }, TX);
}

// After a product / access change: an unpaid bill for the next due date is
// re-priced from the new terms (its discounts stay; a setup fee it already
// carries stays). A bill with money on it is never touched.
export async function repriceOpenBill({ db, FieldValue, businessId, operator }) {
  const bRef = db.collection("businesses").doc(businessId);
  const b = await bRef.get();
  if (!b.exists) return null;
  const sub = b.data().subscription || {};
  if (!sub.billingType) return null;
  if (sub.upgradeDue?.invoiceId) return repriceUpgradeBill({ db, FieldValue, businessId, operator });
  const created = b.data().createdAt?.toDate ? businessDate(BILLING_TIMEZONE, b.data().createdAt.toDate()) : null;
  const t = subscriptionTerms(sub, { createdDay: created });
  if (!t.dueDate) return null;
  const ref = invoices(db).doc(invoiceId(businessId, periodOfDay(t.dueDate)));
  return db.runTransaction(async (tx) => {
    const [snap, fresh] = await Promise.all([tx.get(ref), tx.get(bRef)]);
    if (!snap.exists || !isEditable(snap.data())) return null;
    const inv = snap.data();
    const hadSetup = (inv.lines || []).some((l) => l.kind === "setup");
    const bill = billFor(fresh.data(), inv.period, { setup: hadSetup });
    if (!bill?.lines) return null;
    if (JSON.stringify(bill.lines) === JSON.stringify(inv.lines) && bill.dueDate === inv.dueDate) return { unchanged: true };
    const amountDue = writeAmount(tx, { db, FieldValue, ref, inv, lines: bill.lines, adjustments: inv.adjustments || [], extra: { dueDate: bill.dueDate, coverFrom: bill.coverFrom, coverTo: bill.coverTo, months: bill.months, planId: fresh.data().subscription?.planId ?? inv.planId, planName: fresh.data().entitlements?.planName ?? inv.planName, ...(bill.prepaid ? { prepaid: true } : {}) } });
    tx.set(audit(db), { type: "billing.bill-repriced", summary: `${inv.period} bill re-priced: ${peso(inv.amountDue)} → ${peso(amountDue)}`, businessId, invoiceId: ref.id, amount: amountDue, actor: operator, before: { lines: inv.lines ?? null, amountDue: inv.amountDue }, after: { lines: bill.lines, amountDue }, at: FieldValue.serverTimestamp() });
    return { invoiceId: ref.id, amountDue };
  }, TX);
}

// An unpaid upgrade bill follows the agreed price set after the product
// change: agreed price − what's been paid toward this access (discounts stay).
async function repriceUpgradeBill({ db, FieldValue, businessId, operator }) {
  const bRef = db.collection("businesses").doc(businessId);
  return db.runTransaction(async (tx) => {
    const b = await tx.get(bRef);
    const sub = b.data()?.subscription || {};
    if (!sub.upgradeDue?.invoiceId) return null;
    const ref = invoices(db).doc(sub.upgradeDue.invoiceId);
    const snap = await tx.get(ref);
    if (!snap.exists || !isEditable(snap.data())) return null;
    const inv = snap.data();
    const paid = int(sub.accessPaid);
    const price = Number.isSafeInteger(sub.priceOverride) ? sub.priceOverride : int(sub.amount);
    const due = Math.max(0, price - paid);
    if (due === sumLines(inv.lines)) return { unchanged: true };
    const planName = b.data().entitlements?.planName ?? sub.planId;
    const lines = [{ kind: "upgrade", label: `Upgrade to ${planName} (${peso(price)} − ${peso(paid)} already paid)`, amount: due }];
    const amountDue = writeAmount(tx, { db, FieldValue, ref, inv, lines, adjustments: inv.adjustments || [] });
    tx.update(bRef, { "subscription.upgradeDue.amount": amountDue });
    tx.set(audit(db), { type: "billing.bill-repriced", summary: `Upgrade bill re-priced: ${peso(inv.amountDue)} → ${peso(amountDue)} (agreed ${peso(price)})`, businessId, invoiceId: ref.id, amount: amountDue, actor: operator, before: { lines: inv.lines, amountDue: inv.amountDue }, after: { lines, amountDue }, at: FieldValue.serverTimestamp() });
    return { invoiceId: ref.id, amountDue };
  }, TX);
}

// Luna Bridal → Luna Bridal Custom on PAID 12-month access: a bill for only
// the difference (agreed Custom price − what's been paid toward this access).
// The access end, the wedding and its links stay. A downgrade bills nothing
// and refunds nothing.
export async function createUpgradeBill({ db, FieldValue, businessId, before, operator, now = new Date() }) {
  const bRef = db.collection("businesses").doc(businessId);
  return db.runTransaction(async (tx) => {
    const b = await tx.get(bRef);
    if (!b.exists) throw new BillingError("not-found", "Business not found");
    const business = b.data();
    const sub = business.subscription || {};
    if (sub.billingType !== "term" || before?.billingType !== "term" || !before?.paidThrough) return null;
    const paid = Number.isSafeInteger(before.accessPaid) ? before.accessPaid : Number.isSafeInteger(before.priceOverride) ? before.priceOverride : int(before.amount);
    const price = Number.isSafeInteger(sub.priceOverride) ? sub.priceOverride : int(sub.amount);
    const due = price - paid;
    if (due <= 0) return { upgradeDue: 0 };
    const today = businessDate(BILLING_TIMEZONE, now);
    const period = periodOfDay(today);
    let ref = invoices(db).doc(`${invoiceId(businessId, period)}-upgrade`);
    for (let n = 2; (await tx.get(ref)).exists && n < 10; n += 1) ref = invoices(db).doc(`${invoiceId(businessId, period)}-upgrade-${n}`);
    const planName = business.entitlements?.planName ?? sub.planId;
    const lines = [{ kind: "upgrade", label: `Upgrade to ${planName} (${peso(price)} − ${peso(paid)} already paid)`, amount: due }];
    const stamp = FieldValue.serverTimestamp();
    tx.create(ref, { schemaVersion: BILLING_SCHEMA_VERSION, kind: "upgrade", businessId, businessName: business.name ?? businessId, workspaceTemplateId: business.workspaceTemplateId ?? null, planId: sub.planId ?? null, planName, period, billingType: "term", dueDate: today, coverFrom: today, coverTo: sub.accessUntil ?? before.accessUntil ?? null, months: 0, lines, adjustments: [], amountDue: due, amountPaid: 0, status: "due", paymentIds: [], createdAt: stamp, updatedAt: stamp });
    tx.set(metricsRef(db, period), { period, amountInvoiced: FieldValue.increment(due), invoicesCreated: FieldValue.increment(1), updatedAt: stamp }, { merge: true });
    tx.set(metricsRef(db, "current"), { outstanding: FieldValue.increment(due), updatedAt: stamp }, { merge: true });
    tx.update(bRef, { "subscription.upgradeDue": { invoiceId: ref.id, amount: due, dueDate: today }, "subscription.accessPaid": paid, updatedAt: stamp });
    const record = { type: "billing.upgrade-billed", summary: `Upgrade to ${planName}: ${peso(price)} − ${peso(paid)} paid = ${peso(due)} due (access end unchanged)`, businessId, invoiceId: ref.id, amount: due, actor: operator, before: { planId: before.planId ?? null, paid }, after: { planId: sub.planId, price, due }, at: stamp };
    tx.set(audit(db), record);
    tx.set(tenantDb(db, businessId).collection("auditLog").doc(), record);
    return { invoiceId: ref.id, upgradeDue: due };
  }, TX);
}

export { nextPeriod };
