// Phase 18.6: Luna subscriptions, tenant payments, Super Luna revenue and
// platform costs. Platform-level money, separate from tenant finances.
import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createSubscriptionHandler } from "../../netlify/functions/subscription.js";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { ensureAuthUser, setOperator, createBusiness, addMember, assignPlan } from "../../netlify/functions/_lib/provisioning.js";
import { billingRun, ensureInvoice, confirmPayment, rejectPayment, submitPayment, tenantSubscription } from "../../netlify/functions/_lib/billing.js";
import { platformOverview, copyRecurringExpenses, usageCost } from "../../netlify/functions/_lib/platform.js";
import { estimateUsageCost, rateFor, grossMarginPct, validatePaymentSubmission, checkProof, periodEnd, dayAfter } from "../../shared/billing.js";

const NOW = new Date("2026-10-16T04:00:00Z"); // Oct 16, Manila
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]).toString("base64");
const proof = { contentType: "image/png", dataBase64: PNG };
let world, opUid;

beforeEach(async () => {
  world = await buildWorld();
  const op = await ensureAuthUser({ auth: world.auth, email: "ops@luna.test", name: "Ops" });
  await setOperator({ ...world, email: op.email, status: "active", reason: "test operator" });
  opUid = op.uid;
  await createBusiness({ ...world, name: "Prado Household", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: "biz-home" });
  const owner = await ensureAuthUser({ auth: world.auth, email: "ownerh@t.test", name: "ownerh" });
  world.uids.ownerh = owner.uid;
  await addMember({ ...world, businessId: "biz-home", uid: owner.uid, email: owner.email, name: "ownerh", roleTemplate: "owner", isAccountOwner: true });
});

const docAt = (p) => world.db.docs.get(p);
const sub = async (uid, businessId, body) => {
  const res = await createSubscriptionHandler({ getAdmin: async () => world, now: () => NOW })({ ...request({ uid, businessId, method: body ? "POST" : "GET" }), body: body ? JSON.stringify(body) : undefined });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const op = async (body, uid = opUid) => {
  const res = await createOperatorHandler({ getAdmin: async () => world })({ ...request({ uid }), httpMethod: "POST", body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
let k = 0;
const key = () => `pay-key-${String(++k).padStart(10, "0")}`;
const submit = (uid, businessId, payment, extra = {}) => sub(uid, businessId, { action: "submit", idempotencyKey: extra.key ?? key(), payment: { period: "2026-10", paymentDate: "2026-10-15", reference: "BT-001", ...payment }, proof: extra.proof ?? proof });
const FV = () => world.admin.firestore.FieldValue;

describe("plans and invoices", () => {
  it("the billing run bills every active / past-due subscription once, at its price snapshot", async () => {
    const r1 = await billingRun({ db: world.db, FieldValue: FV(), period: "2026-10" });
    const r2 = await billingRun({ db: world.db, FieldValue: FV(), period: "2026-10" });
    expect(r1.ran).toBe(true);
    expect(r2.ran).toBe(false);
    // biz-a growth ₱1,990, biz-b starter ₱990, biz-home household-plus ₱299; suspended / cancelled not billed.
    expect(docAt("subscriptionInvoices/biz-a_2026-10")).toMatchObject({ amountDue: 199000, planId: "growth", planName: "Growth", status: "due", dueDate: "2026-10-07", workspaceTemplateId: "distributor" });
    expect(docAt("subscriptionInvoices/biz-home_2026-10")).toMatchObject({ amountDue: 29900, planName: "Household Plus" });
    expect(docAt("subscriptionInvoices/biz-s_2026-10")).toBeUndefined();
    expect(docAt("subscriptionInvoices/biz-x_2026-10")).toBeUndefined();
    // Opening the page as a suspended / cancelled business doesn't bill it either.
    expect(await ensureInvoice({ db: world.db, FieldValue: FV(), businessId: "biz-s", period: "2026-11" })).toBeNull();
    expect(await ensureInvoice({ db: world.db, FieldValue: FV(), businessId: "biz-x", period: "2026-11" })).toBeNull();
    expect(docAt("subscriptionInvoices/biz-s_2026-11")).toBeUndefined();
    expect(docAt("platformMetrics/current").outstanding).toBe(199000 + 99000 + 29900);
    // A later price change never rewrites the bill already made.
    world.db.docs.get("businesses/biz-a").subscription.monthlyAmount = 249000;
    await ensureInvoice({ db: world.db, FieldValue: FV(), businessId: "biz-a", period: "2026-10" });
    expect(docAt("subscriptionInvoices/biz-a_2026-10").amountDue).toBe(199000);
  });

  it("changing plan snapshots the new price for the NEXT bills only", async () => {
    await ensureInvoice({ db: world.db, FieldValue: FV(), businessId: "biz-home", period: "2026-10" });
    await assignPlan({ ...world, businessId: "biz-home", planId: "household-basic", actor: "ops", reason: "downgrade" });
    expect(docAt("businesses/biz-home").subscription.monthlyAmount).toBe(14900);
    expect(docAt("subscriptionInvoices/biz-home_2026-10").amountDue).toBe(29900);
    await ensureInvoice({ db: world.db, FieldValue: FV(), businessId: "biz-home", period: "2026-11" });
    expect(docAt("subscriptionInvoices/biz-home_2026-11")).toMatchObject({ amountDue: 14900, planName: "Household Basic" });
  });
});

describe("tenant Subscription page", () => {
  it("the Owner sees plan, amount due, billing month, due date and Luna's bank details; Staff and other tenants can't", async () => {
    await op({ action: "saveBillingSettings", settings: { bankName: "BDO", accountName: "Luna Digital", accountNumber: "0012-3456-78", instructions: "Put your business name in the note." } });
    const r = await sub(world.uids.ownerh, "biz-home");
    expect(r.status).toBe(200);
    expect(r.body.subscription).toMatchObject({ plan: { id: "household-plus", name: "Household Plus" }, status: "active", monthlyAmount: 29900, current: { period: "2026-10", dueDate: "2026-10-07", amountDue: 29900, balance: 29900, status: "due" }, instructions: { bankName: "BDO", accountNumber: "0012-3456-78" } });
    expect((await sub(world.uids.staffa, "biz-a")).status).toBe(403);
    expect((await sub(world.uids.managera, "biz-a")).status).toBe(403); // managers have no billing.view
    expect((await sub(world.uids.ownera, "biz-home")).status).toBe(403); // not a member
    expect(JSON.stringify(r.body)).not.toMatch(/margin|platformCost|verifiedRevenue/i);
  });

  it("submit: proof required and checked (type, size, magic bytes), amount > 0, no future date; becomes For Verification, never Paid", async () => {
    expect((await submit(world.uids.ownerh, "biz-home", { amount: 29900 }, { proof: { contentType: "image/png", dataBase64: Buffer.from("not an image").toString("base64") } })).body.error).toBe("invalid-proof");
    expect((await submit(world.uids.ownerh, "biz-home", { amount: 29900 }, { proof: { contentType: "image/gif", dataBase64: PNG } })).body.error).toBe("invalid-proof");
    expect((await submit(world.uids.ownerh, "biz-home", { amount: 0 })).status).toBe(400);
    expect((await submit(world.uids.ownerh, "biz-home", { amount: 29900, paymentDate: "2026-10-20" })).status).toBe(400);
    expect((await submit(world.uids.ownerh, "biz-home", { amount: 29900, reference: "" })).status).toBe(400);
    const ok = await submit(world.uids.ownerh, "biz-home", { amount: 29900 });
    expect(ok.status).toBe(201);
    const p = docAt(`subscriptionPayments/${ok.body.paymentId}`);
    expect(p).toMatchObject({ status: "for_verification", businessId: "biz-home", workspaceTemplateId: "household-payroll", planId: "household-plus", planNameSnapshot: "Household Plus", period: "2026-10", amountDue: 29900, amountSubmitted: 29900, reference: "BT-001" });
    expect(p.proof.path).toMatch(/^platformBilling\/biz-home\//);
    expect(docAt("subscriptionInvoices/biz-home_2026-10").status).toBe("for_verification");
    expect(docAt("businesses/biz-home").subscription.paidThrough).toBeNull();
    // Luna's billing file isn't the tenant's storage.
    expect(docAt("businesses/biz-home/usageCurrent/storage")?.bytes ?? 0).toBe(0);
    // The Owner is told it was sent.
    const inbox = [...world.db.docs.keys()].filter((x) => x.startsWith(`businesses/biz-home/members/${world.uids.ownerh}/inbox/`));
    expect(inbox.some((x) => docAt(x).type === "billing.payment_update")).toBe(true);
  });

  it("a retry with the same key is one submission; a suspended business can still pay", async () => {
    const r1 = await submit(world.uids.ownerh, "biz-home", { amount: 29900 }, { key: "same-key-0000000001" });
    const r2 = await submit(world.uids.ownerh, "biz-home", { amount: 29900 }, { key: "same-key-0000000001" });
    expect(r2.body).toMatchObject({ paymentId: r1.body.paymentId, alreadySubmitted: true });
    expect([...world.db.docs.keys()].filter((x) => x.startsWith("subscriptionPayments/"))).toHaveLength(1);
    expect(world.storage.files ? [...world.storage.files.keys()].filter((x) => x.startsWith("platformBilling/")).length : 1).toBe(1);
    await ensureInvoice({ db: world.db, FieldValue: FV(), businessId: "biz-b", period: "2026-10" });
    world.db.docs.get("businesses/biz-b").subscription.status = "suspended";
    expect((await submit(world.uids.ownerb, "biz-b", { amount: 99000 })).status).toBe(201);
  });
});

describe("Super Luna: confirm / reject", () => {
  it("confirm: Paid, paid-through and next renewal move, revenue counted ONCE (double confirm is a no-op)", async () => {
    world.db.docs.get("businesses/biz-home").subscription.status = "past_due";
    const s = await submit(world.uids.ownerh, "biz-home", { amount: 29900 });
    const c1 = await confirmPayment({ db: world.db, FieldValue: FV(), paymentId: s.body.paymentId, operator: "ops@luna.test", now: NOW });
    const c2 = await confirmPayment({ db: world.db, FieldValue: FV(), paymentId: s.body.paymentId, operator: "ops@luna.test", now: NOW });
    expect(c1).toMatchObject({ status: "paid", invoiceStatus: "paid", paidThrough: "2026-10-31", nextRenewal: "2026-11-01", verifiedMonth: "2026-10" });
    expect(c2).toMatchObject({ alreadyDecided: true, status: "paid" });
    expect(docAt("businesses/biz-home").subscription).toMatchObject({ status: "active", paidThrough: "2026-10-31", nextRenewal: "2026-11-01" });
    expect(docAt("platformMetrics/2026-10")).toMatchObject({ verifiedRevenue: 29900, paymentsVerified: 1, revenueByWorkspace: { "household-payroll": 29900 }, revenueByPlan: { "household-plus": 29900 } });
    expect(docAt("platformMetrics/current")).toMatchObject({ awaitingCount: 0, awaitingAmount: 0 });
    const audits = [...world.db.docs.keys()].filter((x) => x.startsWith("platformAudit/")).map((x) => docAt(x)).filter((a) => a.type === "subscription.payment-confirmed");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "ops@luna.test", before: { status: "past_due", paidThrough: null }, after: { status: "active", paidThrough: "2026-10-31" } });
  });

  // (Confirm racing confirm / reject runs on the real emulator: tests/emulator/billing-concurrency.test.js.)

  it("decided payments stay decided; paying an older month never moves paid-through back; a suspension stays the operator's call", async () => {
    const nov = await submit(world.uids.ownerh, "biz-home", { amount: 29900, period: "2026-10" });
    await confirmPayment({ db: world.db, FieldValue: FV(), paymentId: nov.body.paymentId, operator: "ops", now: NOW });
    expect(await rejectPayment({ db: world.db, FieldValue: FV(), paymentId: nov.body.paymentId, operator: "ops", reason: "Too late" })).toMatchObject({ alreadyDecided: true, status: "paid" });
    expect(docAt(`subscriptionPayments/${nov.body.paymentId}`).status).toBe("paid");
    // An older month (September) paid afterwards: paid-through stays Oct 31.
    await ensureInvoice({ db: world.db, FieldValue: FV(), businessId: "biz-home", period: "2026-09" });
    const sep = await submit(world.uids.ownerh, "biz-home", { amount: 29900, period: "2026-09" });
    await confirmPayment({ db: world.db, FieldValue: FV(), paymentId: sep.body.paymentId, operator: "ops", now: NOW });
    expect(docAt("businesses/biz-home").subscription).toMatchObject({ paidThrough: "2026-10-31", nextRenewal: "2026-11-01" });
    // Suspended: paying doesn't lift the suspension.
    world.db.docs.get("businesses/biz-b").subscription.status = "suspended";
    await ensureInvoice({ db: world.db, FieldValue: FV(), businessId: "biz-b", period: "2026-10" }).catch(() => {});
    world.db.docs.get("businesses/biz-b").subscription.status = "active";
    await ensureInvoice({ db: world.db, FieldValue: FV(), businessId: "biz-b", period: "2026-10" });
    world.db.docs.get("businesses/biz-b").subscription.status = "suspended";
    const b = await submit(world.uids.ownerb, "biz-b", { amount: 99000 });
    await confirmPayment({ db: world.db, FieldValue: FV(), paymentId: b.body.paymentId, operator: "ops", now: NOW });
    expect(docAt("businesses/biz-b").subscription).toMatchObject({ status: "suspended", paidThrough: "2026-10-31" });
  });

  it("a partial payment leaves the rest due; a reject needs a reason, the tenant sees it, and can send a new proof", async () => {
    const s1 = await submit(world.uids.ownerh, "biz-home", { amount: 10000 });
    await confirmPayment({ db: world.db, FieldValue: FV(), paymentId: s1.body.paymentId, operator: "ops", now: NOW });
    expect(docAt("subscriptionInvoices/biz-home_2026-10")).toMatchObject({ amountPaid: 10000, status: "due" });
    expect(docAt("businesses/biz-home").subscription.paidThrough).toBeNull();
    const s2 = await submit(world.uids.ownerh, "biz-home", { amount: 19900, reference: "BT-002" });
    expect((await op({ action: "rejectPayment", paymentId: s2.body.paymentId, reason: "" })).body.error).toBe("reason-required");
    expect((await op({ action: "rejectPayment", paymentId: s2.body.paymentId, reason: "The reference doesn't match our bank" })).status).toBe(200);
    const view = (await sub(world.uids.ownerh, "biz-home")).body.subscription;
    expect(view.payments.find((p) => p.id === s2.body.paymentId)).toMatchObject({ status: "rejected", statusLabel: "Payment Rejected", rejectionReason: "The reference doesn't match our bank" });
    expect(view.current).toMatchObject({ status: "due", balance: 19900 });
    const s3 = await submit(world.uids.ownerh, "biz-home", { amount: 19900, reference: "BT-003" });
    expect(s3.status).toBe(201);
    await confirmPayment({ db: world.db, FieldValue: FV(), paymentId: s3.body.paymentId, operator: "ops", now: NOW });
    expect(docAt("subscriptionInvoices/biz-home_2026-10")).toMatchObject({ amountPaid: 29900, status: "paid" });
    expect(docAt(`subscriptionPayments/${s2.body.paymentId}`).status).toBe("rejected"); // never erased
    expect((await submit(world.uids.ownerh, "biz-home", { amount: 100 })).body.error).toBe("already-paid");
  });

  it("only operators: a tenant Owner can't confirm, read proofs, revenue or costs", async () => {
    const s = await submit(world.uids.ownerh, "biz-home", { amount: 29900 });
    for (const body of [{ action: "confirmPayment", paymentId: s.body.paymentId }, { action: "paymentProof", paymentId: s.body.paymentId }, { action: "money" }, { action: "expenses", month: "2026-10" }, { action: "economics", period: "2026-10" }]) {
      expect((await op(body, world.uids.ownerh)).status, body.action).toBe(403);
    }
    const p = await op({ action: "paymentProof", paymentId: s.body.paymentId });
    expect(p.body.proof).toEqual({ contentType: "image/png", dataBase64: PNG });
    expect(docAt(`subscriptionPayments/${s.body.paymentId}`).status).toBe("for_verification");
  });
});

describe("Super Luna Overview: the money story", () => {
  it("collected (verified only), MRR, still to collect vs for verification, platform costs, estimated gross profit and margin", async () => {
    const pay = async (uid, biz, amount) => (await submit(uid, biz, { amount })).body.paymentId;
    const a = await pay(world.uids.ownera, "biz-a", 199000);
    await pay(world.uids.ownerh, "biz-home", 29900); // stays For Verification
    await confirmPayment({ db: world.db, FieldValue: FV(), paymentId: a, operator: "ops", now: NOW });
    await op({ action: "addExpense", expense: { month: "2026-10", category: "firebase_gcp", description: "Firebase October", amount: 142000, kind: "recurring" } });
    await op({ action: "addExpense", expense: { month: "2026-10", category: "netlify", description: "Netlify", amount: 110000, kind: "recurring" } });
    const m = await platformOverview({ db: world.db, FieldValue: FV(), AggregateField: world.admin.firestore.AggregateField, now: NOW });
    expect(m.collected).toBe(199000); // the household payment isn't counted until verified
    expect(m.mrr).toBe(199000 + 99000 + 29900); // active biz-a, biz-b, biz-home
    expect(m.activeSubscriptions).toBe(3);
    expect(m.awaiting).toEqual({ count: 1, amount: 29900 });
    expect(m.stillToCollect).toBe(99000); // biz-b's bill; the household's is awaiting review
    expect(m.platformCosts).toBe(252000);
    expect(m.infraCosts).toBe(252000);
    expect(m.estimatedGrossProfit).toBe(199000 - 252000);
    expect(m.estimatedGrossMargin).toBe(grossMarginPct(199000 - 252000, 199000));
    expect(m.trend).toHaveLength(12);
    expect(m.trend.at(-1)).toEqual({ period: "2026-10", revenue: 199000, costs: 252000, grossProfit: -53000 });
    expect(m.revenueByWorkspace.find((w) => w.workspaceTemplateId === "distributor")).toMatchObject({ revenue: 199000, mrr: 298000, subscriptions: 2 });
    expect(m.revenueByWorkspace.find((w) => w.workspaceTemplateId === "household-payroll")).toMatchObject({ revenue: 0, mrr: 29900, subscriptions: 1 });
  });
});

describe("platform expenses and the cost rate card", () => {
  it("expenses: add, edit, remove (kept, audited); recurring items copy to the next month once", async () => {
    const id = (await op({ action: "addExpense", expense: { month: "2026-09", category: "netlify", description: "Netlify Pro", amount: 110000, kind: "recurring" } })).body.expenseId;
    await op({ action: "addExpense", expense: { month: "2026-09", category: "domain_dns", description: "Domain", amount: 15000, kind: "one_time" } });
    expect((await op({ action: "addExpense", expense: { month: "2026-09", category: "rent", description: "x", amount: 1, kind: "one_time" } })).status).toBe(400);
    await op({ action: "editExpense", expenseId: id, changes: { amount: 112000 } });
    const c1 = await copyRecurringExpenses({ db: world.db, FieldValue: FV(), month: "2026-10", actor: "ops" });
    const c2 = await copyRecurringExpenses({ db: world.db, FieldValue: FV(), month: "2026-10", actor: "ops" });
    expect([c1.copied, c2.copied]).toEqual([1, 0]);
    const oct = (await op({ action: "expenses", month: "2026-10" })).body;
    expect(oct.rows.map((r) => [r.category, r.amount])).toEqual([["netlify", 112000]]);
    expect(oct.total).toBe(112000);
    const sep = (await op({ action: "expenses", month: "2026-09" })).body;
    const dom = sep.rows.find((r) => r.category === "domain_dns");
    await op({ action: "removeExpense", expenseId: dom.id, reason: "Entered twice" });
    expect((await op({ action: "expenses", month: "2026-09" })).body.total).toBe(112000);
    expect(docAt(`platformExpenses/${dom.id}`).status).toBe("removed");
    // Luna's costs never become tenant Expenses.
    expect([...world.db.docs.keys()].some((x) => /^businesses\/[^/]+\/expenses\//.test(x))).toBe(false);
  });

  it("rates are versioned: a later rate never rewrites an earlier month; unmeasured resources are Unavailable", async () => {
    await op({ action: "addCostRate", rate: { resource: "storage_gb_month", ratePerUnit: 150, effectiveFrom: "2026-01-01" } });
    await op({ action: "addCostRate", rate: { resource: "storage_gb_month", ratePerUnit: 300, effectiveFrom: "2026-11-01" } });
    expect((await op({ action: "addCostRate", rate: { resource: "firestore_reads", ratePerUnit: -1, effectiveFrom: "2026-01-01" } })).status).toBe(400);
    const rates = (await op({ action: "costRates" })).body.rates;
    expect(rateFor(rates, "storage_gb_month", "2026-10").ratePerUnit).toBe(150);
    expect(rateFor(rates, "storage_gb_month", "2026-11").ratePerUnit).toBe(300);
    const est = estimateUsageCost({ storageBytes: 2 * 1024 ** 3, exportBytes: null }, rates, "2026-10");
    expect(est.lines.find((l) => l.resource === "storage_gb_month")).toMatchObject({ measured: true, cost: 300 });
    for (const r of ["firestore_reads", "firestore_writes", "firestore_deletes", "function_invocations", "export_download_gb"]) expect(est.lines.find((l) => l.resource === r).cost, r).toBeNull();
    expect(est).toMatchObject({ total: 300, complete: false });
  });

  it("usage cost per tenant: commercial usage kept apart from infrastructure, revenue = paid on the month's bill", async () => {
    await op({ action: "addCostRate", rate: { resource: "storage_gb_month", ratePerUnit: 150, effectiveFrom: "2026-01-01" } });
    world.db.seed("businesses/biz-a/usageCurrent/storage", { bytes: 1024 ** 3 });
    world.db.seed("businesses/biz-a/usage/2026-10", { ordersCreated: 428, exportsGenerated: 18, rowsExported: 14250, exportBytes: 5 * 1024 ** 2 });
    const s = await submit(world.uids.ownera, "biz-a", { amount: 199000 });
    await confirmPayment({ db: world.db, FieldValue: FV(), paymentId: s.body.paymentId, operator: "ops", now: NOW });
    const r = await usageCost({ db: world.db, period: "2026-10" });
    const a = r.rows.find((x) => x.id === "biz-a");
    expect(a.commercial).toMatchObject({ orders: 428, exports: 18, rowsExported: 14250, storageBytes: 1024 ** 3 });
    expect(a.infrastructure).toEqual({ storageBytes: 1024 ** 3, exportBytes: 5 * 1024 ** 2 });
    expect(a.estimate.total).toBe(150);
    expect(a).toMatchObject({ revenue: 199000, directMargin: 199000 - 150 });
  });
});

describe("shared billing rules", () => {
  it("periods, proof sniffing and submission validation", () => {
    expect(periodEnd("2026-02")).toBe("2026-02-28");
    expect(dayAfter("2026-12-31")).toBe("2027-01-01");
    expect(() => checkProof(Buffer.from(PNG, "base64"), "image/png")).not.toThrow();
    expect(() => checkProof(Buffer.alloc(3 * 1024 * 1024 + 1, 0x89), "image/png")).toThrow(/3 MB/);
    expect(() => validatePaymentSubmission({ period: "2026-13", amount: 1, paymentDate: "2026-10-01", reference: "x" }, { today: "2026-10-16" })).toThrow();
    expect(validatePaymentSubmission({ period: "2026-10", amount: 1, paymentDate: "2026-10-01", reference: " BT  1 " }, { today: "2026-10-16" })).toMatchObject({ method: "bank_transfer", reference: "BT 1" });
    expect(grossMarginPct(44000, 50000)).toBe(88);
    expect(grossMarginPct(1, 0)).toBeNull();
  });
});
