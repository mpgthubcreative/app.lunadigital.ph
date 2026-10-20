// Super Luna money and costs, server side (Phase 18.6): the Overview story,
// the payments queue, subscriptions, Luna's own platform expenses, the cost
// rate card and the per-tenant usage-cost estimate. Operators only (every
// caller is /api/operator, behind requireOperator). Reads use summary
// documents (platformMetrics) and aggregation queries, never a scan of every
// record on a dashboard load.

import { BillingError, BILLABLE_STATUSES, PLATFORM_EXPENSE_CATEGORIES, validatePlatformExpense, validateCostRate, estimateUsageCost, grossProfit, grossMarginPct, lastPeriods, previousPeriod, isPeriod, invoiceId, PAYMENT_STATUS_IDS } from "../../../shared/billing.js";
import { WORKSPACE_TEMPLATE_IDS } from "../../../shared/workspaces.js";
import { tenantDb } from "./tenant-db.js";
import { readStorageCurrent } from "./metering.js";
import { billingRun, currentPeriod } from "./billing.js";
import { subscriptionTerms, attentionOf, accessState, BILLING_TYPES } from "../../../shared/plan-billing.js";
import { businessDate } from "../../../shared/metrics.js";
import { BILLING_TIMEZONE } from "../../../shared/billing.js";

const TX = { maxAttempts: 10 };
const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const iso = (ts) => ts?.toDate?.().toISOString?.() ?? null;
const PAGE = 25;
const expensesCol = (db) => db.collection("platformExpenses");
const ratesCol = (db) => db.collection("platformCostRates");
const audit = (db) => db.collection("platformAudit").doc();

// ---------- Platform expenses ----------

export async function expensesForMonths(db, periods) {
  if (!periods.length) return [];
  const snap = await expensesCol(db).where("month", ">=", periods[0]).where("month", "<=", periods.at(-1)).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => e.status !== "removed");
}
const costsByMonth = (expenses) => {
  const out = {};
  for (const e of expenses) {
    const m = (out[e.month] ??= { total: 0, infra: 0 });
    m.total += e.amount;
    if (PLATFORM_EXPENSE_CATEGORIES[e.category]?.infra) m.infra += e.amount;
  }
  return out;
};
const expenseView = (e) => ({ id: e.id, month: e.month, category: e.category, description: e.description, amount: e.amount, kind: e.kind, notes: e.notes ?? null, reference: e.reference ?? null, updatedAt: iso(e.updatedAt) });

export async function listPlatformExpenses({ db, month }) {
  if (!isPeriod(month)) throw new BillingError("invalid-input", "Choose a month");
  const rows = (await expensesForMonths(db, [month])).sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  const c = costsByMonth(rows)[month] ?? { total: 0, infra: 0 };
  return { month, rows: rows.map(expenseView), total: c.total, infra: c.infra };
}

export async function createPlatformExpense({ db, FieldValue, input, actor }) {
  const data = validatePlatformExpense(input);
  for (const k of ["month", "category", "description", "amount", "kind"]) if (data[k] === undefined) throw new BillingError("invalid-input", `${k} is required`);
  const ref = expensesCol(db).doc();
  const stamp = FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.set(ref, { ...data, notes: data.notes ?? null, reference: data.reference ?? null, status: "active", createdBy: actor, createdAt: stamp, updatedBy: actor, updatedAt: stamp });
  batch.set(audit(db), { type: "platform.expense-added", expenseId: ref.id, actor, after: data, at: stamp });
  await batch.commit();
  return { expenseId: ref.id };
}

export async function updatePlatformExpense({ db, FieldValue, expenseId, changes, actor }) {
  const data = validatePlatformExpense(changes, { partial: true });
  const ref = expensesCol(db).doc(String(expenseId || "-"));
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists || s.data().status === "removed") throw new BillingError("not-found", "Expense not found");
    const before = Object.fromEntries(Object.keys(data).map((k) => [k, s.data()[k] ?? null]));
    const stamp = FieldValue.serverTimestamp();
    tx.update(ref, { ...data, updatedBy: actor, updatedAt: stamp });
    tx.set(audit(db), { type: "platform.expense-edited", expenseId: ref.id, actor, before, after: data, at: stamp });
    return { expenseId: ref.id };
  }, TX);
}

// Removing keeps the record (status removed) and the audit trail.
export async function removePlatformExpense({ db, FieldValue, expenseId, reason, actor }) {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3) throw new BillingError("reason-required", "Give a reason");
  const ref = expensesCol(db).doc(String(expenseId || "-"));
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists || s.data().status === "removed") throw new BillingError("not-found", "Expense not found");
    const stamp = FieldValue.serverTimestamp();
    tx.update(ref, { status: "removed", removedBy: actor, removedAt: stamp, removeReason: why, updatedAt: stamp });
    tx.set(audit(db), { type: "platform.expense-removed", expenseId: ref.id, actor, reason: why, before: { month: s.data().month, category: s.data().category, amount: s.data().amount }, at: stamp });
    return { expenseId: ref.id, removed: true };
  }, TX);
}

// Copies last month's RECURRING items into `month`, once per item
// (deterministic ids: running it twice adds nothing).
export async function copyRecurringExpenses({ db, FieldValue, month, actor }) {
  if (!isPeriod(month)) throw new BillingError("invalid-input", "Choose a month");
  const prev = (await expensesForMonths(db, [previousPeriod(month)])).filter((e) => e.kind === "recurring");
  let copied = 0;
  for (const e of prev) {
    const ref = expensesCol(db).doc(`${e.id}_${month}`.slice(0, 120));
    const created = await db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists) return false;
      const stamp = FieldValue.serverTimestamp();
      tx.set(ref, { month, category: e.category, description: e.description, amount: e.amount, kind: "recurring", notes: e.notes ?? null, reference: null, copiedFrom: e.id, status: "active", createdBy: actor, createdAt: stamp, updatedBy: actor, updatedAt: stamp });
      tx.set(audit(db), { type: "platform.expense-added", expenseId: ref.id, actor, after: { month, category: e.category, amount: e.amount, kind: "recurring", copiedFrom: e.id }, at: stamp });
      return true;
    }, TX);
    if (created) copied += 1;
  }
  return { month, copied, considered: prev.length };
}

// ---------- Cost rate card (append-only versions) ----------

export async function listCostRates({ db }) {
  const snap = await ratesCol(db).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: iso(d.data().createdAt) })).sort((a, b) => (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : a.effectiveFrom < b.effectiveFrom ? 1 : -1));
}

export async function addCostRate({ db, FieldValue, input, actor }) {
  const rate = validateCostRate(input);
  const ref = ratesCol(db).doc();
  const stamp = FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.set(ref, { ...rate, createdBy: actor, createdAt: stamp });
  batch.set(audit(db), { type: "platform.cost-rate-added", rateId: ref.id, actor, after: rate, at: stamp });
  await batch.commit();
  return { rateId: ref.id };
}

// ---------- Usage cost per tenant ----------

// Measured usage (storage now, export bytes this month) × the month's rates.
// Revenue per tenant = what was paid on that month's invoice.
export async function usageCost({ db, period, after = null }) {
  if (!isPeriod(period)) throw new BillingError("invalid-input", "Choose a month");
  const rates = await listCostRates({ db });
  let q = db.collection("businesses").orderBy("__name__").limit(PAGE + 1);
  if (after) q = q.startAfter(after);
  const docs = (await q.get()).docs;
  const page = docs.slice(0, PAGE);
  const rows = await Promise.all(
    page.map(async (d) => {
      const b = d.data();
      const tenant = tenantDb(db, d.id);
      const [usage, storage, inv] = await Promise.all([tenant.doc("usage", period).get(), readStorageCurrent(tenant), db.collection("subscriptionInvoices").doc(invoiceId(d.id, period)).get()]);
      const u = usage.exists ? usage.data() : {};
      const est = estimateUsageCost({ storageBytes: storage.bytes, exportBytes: Number.isSafeInteger(u.exportBytes) ? u.exportBytes : null }, rates, period);
      const revenue = inv.exists ? int(inv.data().amountPaid) : 0;
      return {
        id: d.id,
        name: b.name,
        workspaceTemplateId: b.workspaceTemplateId ?? null,
        planId: b.subscription?.planId ?? null,
        status: b.subscription?.status ?? null,
        limits: b.entitlements?.limits ?? null,
        commercial: { orders: int(u.ordersCreated), imports: int(u.excelImports), exports: int(u.exportsGenerated), rowsExported: int(u.rowsExported), storageBytes: storage.bytes },
        infrastructure: { storageBytes: storage.bytes, exportBytes: Number.isSafeInteger(u.exportBytes) ? u.exportBytes : null },
        estimate: est,
        revenue,
        directMargin: revenue - est.total,
      };
    })
  );
  return { period, rows, next: docs.length > PAGE ? page.at(-1).id : null, ratesConfigured: rates.length > 0 };
}

// Whole-platform rollup for a month (all businesses; small numbers today).
// Direct estimated usage cost only: shared platform costs aren't allocated.
export async function economics({ db, period }) {
  const all = [];
  let after = null;
  do {
    const page = await usageCost({ db, period, after });
    all.push(...page.rows);
    after = page.next;
  } while (after);
  const roll = (key) => {
    const out = {};
    for (const r of all) {
      const k = r[key] ?? "unknown";
      const g = (out[k] ??= { key: k, tenants: 0, subscribers: 0, revenue: 0, estimatedCost: 0 });
      g.tenants += 1;
      if (BILLABLE_STATUSES.includes(r.status)) g.subscribers += 1;
      g.revenue += r.revenue;
      g.estimatedCost += r.estimate.total;
    }
    return Object.values(out).map((g) => ({ ...g, estimatedGrossProfit: g.revenue - g.estimatedCost, margin: grossMarginPct(g.revenue - g.estimatedCost, g.revenue) }));
  };
  const top = [...all].sort((a, b) => b.estimate.total - a.estimate.total || b.infrastructure.storageBytes - a.infrastructure.storageBytes).slice(0, 10);
  return { period, byWorkspace: roll("workspaceTemplateId"), byPlan: roll("planId"), topConsumers: top, estimatedTotal: all.reduce((s, r) => s + r.estimate.total, 0) };
}

// ---------- Overview (the money story) ----------

async function sumMrr(db, AggregateField, extra = null) {
  let q = db.collection("businesses").where("subscription.status", "in", BILLABLE_STATUSES);
  if (extra) q = q.where("workspaceTemplateId", "==", extra);
  const r = (await q.aggregate({ mrr: AggregateField.sum("subscription.monthlyAmount"), n: AggregateField.count() }).get()).data();
  return { mrr: int(r.mrr), subscriptions: int(r.n) };
}

export async function platformOverview({ db, FieldValue, AggregateField, now = new Date() }) {
  const period = currentPeriod(now);
  await billingRun({ db, FieldValue, period });
  const months = lastPeriods(period, 12);
  const [metricSnaps, current, expenses, totals, pastDue, ...byWs] = await Promise.all([
    Promise.all(months.map((m) => db.collection("platformMetrics").doc(m).get())),
    db.collection("platformMetrics").doc("current").get(),
    expensesForMonths(db, months),
    sumMrr(db, AggregateField),
    db.collection("businesses").where("subscription.status", "==", "past_due").limit(10).get(),
    ...WORKSPACE_TEMPLATE_IDS.map((w) => sumMrr(db, AggregateField, w)),
  ]);
  const metrics = Object.fromEntries(months.map((m, i) => [m, metricSnaps[i].exists ? metricSnaps[i].data() : {}]));
  const costs = costsByMonth(expenses);
  const c = current.exists ? current.data() : {};
  const thisMonth = metrics[period];
  const collected = int(thisMonth.verifiedRevenue);
  const platformCosts = costs[period]?.total ?? 0;
  const gp = grossProfit(collected, platformCosts);
  const dueOpen = await db.collection("subscriptionInvoices").where("period", "==", period).where("status", "in", ["due", "for_verification"]).limit(50).get();
  return {
    period,
    collected,
    mrr: totals.mrr,
    activeSubscriptions: totals.subscriptions,
    stillToCollect: Math.max(0, int(c.outstanding) - Math.max(0, int(c.awaitingAmount))),
    outstanding: Math.max(0, int(c.outstanding)),
    awaiting: { count: Math.max(0, int(c.awaitingCount)), amount: Math.max(0, int(c.awaitingAmount)) },
    pastDueCount: pastDue.size,
    platformCosts,
    infraCosts: costs[period]?.infra ?? 0,
    estimatedGrossProfit: gp,
    estimatedGrossMargin: grossMarginPct(gp, collected),
    trend: months.map((m) => {
      const rev = int(metrics[m].verifiedRevenue);
      const cost = costs[m]?.total ?? 0;
      return { period: m, revenue: rev, costs: cost, grossProfit: grossProfit(rev, cost) };
    }),
    revenueByWorkspace: WORKSPACE_TEMPLATE_IDS.map((w, i) => ({ workspaceTemplateId: w, revenue: int(thisMonth.revenueByWorkspace?.[w]), mrr: byWs[i].mrr, subscriptions: byWs[i].subscriptions })),
    revenueByPlan: Object.entries(thisMonth.revenueByPlan || {}).map(([planId, revenue]) => ({ planId, revenue: int(revenue) })),
    dueThisMonth: dueOpen.docs.map((d) => ({ businessId: d.data().businessId, businessName: d.data().businessName, workspaceTemplateId: d.data().workspaceTemplateId, planName: d.data().planName, amountDue: d.data().amountDue, amountPaid: d.data().amountPaid, status: d.data().status, dueDate: d.data().dueDate })),
    pastDue: pastDue.docs.map((d) => ({ businessId: d.id, name: d.data().name, workspaceTemplateId: d.data().workspaceTemplateId, planId: d.data().subscription?.planId, paidThrough: d.data().subscription?.paidThrough ?? null })),
  };
}

// ---------- Super Admin Overview + Action Center (2026-10-19) ----------
//
// Short and actionable: active subscriptions / access, recurring income,
// annual / 12-month income collected this month, what Needs Attention (due,
// overdue, expiring, expired: real dates) and Income by Workspace. No cost,
// profit or margin here. Recurring income is Distributor monthly prices
// only: Household annual and Bridal 12-month access are never turned into a
// monthly number.

const OVERVIEW_LIMIT = 500;
const WORKSPACE_BILLING = { distributor: "monthly", "household-payroll": "annual", "bridal-expense": "term", "baby-expense": "monthly" };
const ATTENTION_ORDER = { overdue: 0, expired: 1, due: 2, expiring: 3 };
const createdDayOf = (b) => (b.createdAt?.toDate ? businessDate(BILLING_TIMEZONE, b.createdAt.toDate()) : null);

// One business's billing state as the console shows it.
export function billingRow(id, b, planNames = {}, today) {
  const sub = b.subscription || {};
  const terms = subscriptionTerms(sub, { createdDay: createdDayOf(b) });
  return {
    id,
    name: b.name ?? id,
    workspaceTemplateId: b.workspaceTemplateId ?? null,
    planId: sub.planId ?? null,
    planName: planNames[sub.planId] ?? b.entitlements?.planName ?? sub.planId ?? null,
    status: sub.status ?? null,
    state: accessState(terms, { status: sub.status, today }),
    billingType: terms.billingType,
    amount: terms.amount,
    // The term the next bill covers, Super Admin's price, the add-ons.
    termMonths: terms.termMonths,
    prepaidNext: terms.prepaidNext,
    priceOverride: terms.priceOverride,
    addOns: terms.addOns.map((a) => ({ id: a.id, label: a.label, qty: a.qty })),
    startDate: terms.startDate,
    dueDate: terms.dueDate,
    renewal: terms.renewal,
    accessUntil: terms.accessUntil,
    paidThrough: terms.paidThrough,
    extended: terms.extended,
    attention: attentionOf(terms, { status: sub.status, today }),
    purgeAfter: b.deletion?.purgeAfter ?? null,
  };
}

export async function lunaOverview({ db, FieldValue, now = new Date() }) {
  const period = currentPeriod(now);
  const today = businessDate(BILLING_TIMEZONE, now);
  await billingRun({ db, FieldValue, period });
  const [snap, metric, current, plans] = await Promise.all([
    db.collection("businesses").limit(OVERVIEW_LIMIT).get(),
    db.collection("platformMetrics").doc(period).get(),
    db.collection("platformMetrics").doc("current").get(),
    db.collection("plans").get(),
  ]);
  const planNames = Object.fromEntries(plans.docs.map((d) => [d.id, d.data().name]));
  const rows = snap.docs.map((d) => billingRow(d.id, d.data(), planNames, today)).filter((r) => r.status !== "deleted");
  const m = metric.exists ? metric.data() : {};
  const c = current.exists ? current.data() : {};
  const live = rows.filter((r) => BILLABLE_STATUSES.includes(r.status) && r.state !== "expired");
  const byType = m.revenueByBillingType || {};
  const workspaces = WORKSPACE_TEMPLATE_IDS.filter((w) => rows.some((r) => r.workspaceTemplateId === w));
  return {
    period,
    today,
    activeAccess: live.length,
    // Only workspaces sold monthly: a Household / Bridal business still on its
    // old monthly terms (before billing types) isn't recurring income.
    recurringIncome: live.filter((r) => r.billingType === "monthly" && (WORKSPACE_BILLING[r.workspaceTemplateId] ?? "monthly") === "monthly").reduce((t, r) => t + (Number.isSafeInteger(r.amount) ? r.amount : 0), 0),
    annualIncomeThisMonth: int(byType.annual) + int(byType.term),
    collectedThisMonth: int(m.verifiedRevenue),
    awaiting: { count: Math.max(0, int(c.awaitingCount)), amount: Math.max(0, int(c.awaitingAmount)) },
    needsAttention: rows
      .filter((r) => r.attention && !r.attention.quiet && r.status !== "cancelled")
      .sort((a, b) => ATTENTION_ORDER[a.attention.kind] - ATTENTION_ORDER[b.attention.kind] || (a.attention.kind === "overdue" ? b.attention.days - a.attention.days : a.attention.date < b.attention.date ? -1 : 1))
      .slice(0, 50),
    incomeByWorkspace: workspaces.map((w) => {
      const mine = live.filter((r) => r.workspaceTemplateId === w);
      // How the workspace is sold (businesses from before billing types still pay monthly).
      const type = WORKSPACE_BILLING[w] ?? "monthly";
      return { workspaceTemplateId: w, billingType: type, billingLabel: BILLING_TYPES[type].label, collected: int(m.revenueByWorkspace?.[w]), recurring: type === "monthly" ? mine.filter((r) => r.billingType === "monthly").reduce((t, r) => t + (Number.isSafeInteger(r.amount) ? r.amount : 0), 0) : null, active: mine.length };
    }),
  };
}

// ---------- Payments queue ----------

const paymentRow = (d) => {
  const p = d.data();
  return { id: d.id, businessId: p.businessId, businessName: p.businessName, workspaceTemplateId: p.workspaceTemplateId, planId: p.planId, planName: p.planNameSnapshot, period: p.period, amountDue: p.amountDue, amountSubmitted: p.amountSubmitted, paymentDate: p.paymentDate, reference: p.reference, status: p.status, submittedAt: iso(p.submittedAt), verifiedAt: iso(p.verifiedAt), rejectedAt: iso(p.rejectedAt), rejectionReason: p.rejectionReason ?? null };
};

// filters: { status?, workspaceTemplateId?, period?, businessId? }. Newest first.
export async function listSubscriptionPayments({ db, filters = {}, after = null }) {
  const f = filters && typeof filters === "object" ? filters : {};
  if (f.status && !PAYMENT_STATUS_IDS.includes(f.status)) throw new BillingError("invalid-input", "Unknown status");
  if (f.period && !isPeriod(f.period)) throw new BillingError("invalid-input", "Invalid month");
  let q = db.collection("subscriptionPayments");
  const memo = [];
  if (f.businessId) q = q.where("businessId", "==", String(f.businessId));
  else if (f.period) q = q.where("period", "==", f.period);
  else {
    if (f.workspaceTemplateId) q = q.where("workspaceTemplateId", "==", String(f.workspaceTemplateId));
    if (f.status) q = q.where("status", "==", f.status);
  }
  // Filters the index doesn't cover are applied on the (bounded) result.
  if (f.businessId || f.period) {
    if (f.status) memo.push((p) => p.status === f.status);
    if (f.workspaceTemplateId) memo.push((p) => p.workspaceTemplateId === f.workspaceTemplateId);
    if (f.businessId && f.period) memo.push((p) => p.period === f.period);
  }
  q = q.orderBy("submittedAt", "desc").limit(memo.length ? 200 : PAGE + 1);
  if (after && !memo.length) {
    const a = await db.collection("subscriptionPayments").doc(String(after)).get();
    if (a.exists) q = q.startAfter(a);
  }
  const docs = (await q.get()).docs.filter((d) => memo.every((fn) => fn(d.data())));
  const page = docs.slice(0, PAGE);
  return { rows: page.map(paymentRow), next: !memo.length && docs.length > PAGE ? page.at(-1).id : null };
}

export async function paymentDetail({ db, paymentId }) {
  const p = await db.collection("subscriptionPayments").doc(String(paymentId || "-")).get();
  if (!p.exists) throw new BillingError("not-found", "Payment not found");
  const pay = p.data();
  const [inv, history] = await Promise.all([db.collection("subscriptionInvoices").doc(pay.invoiceId).get(), db.collection("subscriptionPayments").where("businessId", "==", pay.businessId).orderBy("submittedAt", "desc").limit(11).get()]);
  return {
    payment: { ...paymentRow(p), method: pay.method, note: pay.note ?? null, hasProof: Boolean(pay.proof?.path), proofType: pay.proof?.contentType ?? null, verifiedBy: pay.verifiedBy ?? null, rejectedBy: pay.rejectedBy ?? null, submittedBy: pay.submittedBy?.email ?? pay.submittedBy?.name ?? null },
    invoice: inv.exists ? { period: inv.data().period, amountDue: inv.data().amountDue, amountPaid: inv.data().amountPaid, status: inv.data().status, dueDate: inv.data().dueDate } : null,
    history: history.docs.filter((d) => d.id !== p.id).slice(0, 10).map(paymentRow),
  };
}

// ---------- Subscriptions ----------

// filters: { status?, workspaceTemplateId? }; 25 per page by business id,
// each with its billing state (dates, attention) and the current month's bill.
export async function listSubscriptions({ db, filters = {}, after = null, now = new Date() }) {
  const f = filters && typeof filters === "object" ? filters : {};
  const period = currentPeriod(now);
  let q = db.collection("businesses");
  if (f.status) q = q.where("subscription.status", "==", String(f.status));
  if (f.workspaceTemplateId) q = q.where("workspaceTemplateId", "==", String(f.workspaceTemplateId));
  q = q.orderBy("__name__").limit(PAGE + 1);
  if (after) q = q.startAfter(String(after));
  const docs = (await q.get()).docs;
  const page = docs.slice(0, PAGE);
  const today = businessDate(BILLING_TIMEZONE, now);
  const invs = await Promise.all(page.map((d) => db.collection("subscriptionInvoices").doc(invoiceId(d.id, period)).get()));
  return {
    period,
    rows: page.map((d, i) => {
      const b = d.data();
      const inv = invs[i].exists ? invs[i].data() : null;
      return { ...billingRow(d.id, b, {}, today), planName: b.entitlements?.planName ?? null, monthlyAmount: b.subscription?.monthlyAmount ?? null, nextRenewal: b.subscription?.nextRenewal ?? null, bill: inv ? { amountDue: inv.amountDue, amountPaid: inv.amountPaid, status: inv.status, dueDate: inv.dueDate } : null };
    }),
    next: docs.length > PAGE ? page.at(-1).id : null,
  };
}
