// The 30-day free trial (2026-10-21): a state on the subscription, never a
// bill. Nothing is billed until the customer chooses a plan on "Continue
// with Luna"; the first PAID bill carries Distributor's ₱250 setup fee; the
// trial converts when that bill is paid. After the trial ends nothing is
// deleted: sign in, the continuation page, choosing a plan, paying and
// Settings → Data work; everyday editing is refused until it's paid.

import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { createSubscriptionHandler } from "../../netlify/functions/subscription.js";
import { createSessionHandler } from "../../netlify/functions/session.js";
import { createCustomersHandler } from "../../netlify/functions/customers.js";
import { createWorkbookHandler } from "../../netlify/functions/workbook.js";
import { ensureAuthUser, setOperator, createBusiness, addMember } from "../../netlify/functions/_lib/provisioning.js";
import { billFor, currentPeriod } from "../../netlify/functions/_lib/billing.js";
import { businessDate } from "../../shared/metrics.js";
import { newTrial, trialState, feedbackPrompt, TRIAL_DAYS } from "../../shared/trial.js";
import { subscriptionTerms } from "../../shared/plan-billing.js";

const NOW = new Date();
const TODAY = businessDate("Asia/Manila", NOW);
const shift = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
let world, opUid;
const u = {};

beforeEach(async () => {
  world = await buildWorld();
  const op = await ensureAuthUser({ auth: world.auth, email: "ops@luna.test", name: "Ops" });
  await setOperator({ ...world, email: op.email, status: "active", reason: "test operator" });
  opUid = op.uid;
});

const biz = (id) => world.db.docs.get(`businesses/${id}`);
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const op = async (body) => parse(await createOperatorHandler(deps())({ ...request({ uid: opUid }), httpMethod: "POST", body: JSON.stringify(body) }));
const sub = async (bid, uid, body = null) => parse(await createSubscriptionHandler(deps())({ ...request({ uid, businessId: bid, method: body ? "POST" : "GET" }), ...(body ? { body: JSON.stringify(body) } : {}) }));
const session = async (bid, uid) => parse(await createSessionHandler(deps())({ ...request({ uid, businessId: bid }), httpMethod: "GET" }));
const customer = async (bid, uid, name) => parse(await createCustomersHandler(deps())({ ...request({ uid, businessId: bid, method: "POST" }), body: JSON.stringify({ action: "create", customer: { name } }) }));
const invoices = (bid) => [...world.db.docs.entries()].filter(([k, v]) => k.startsWith("subscriptionInvoices/") && v.businessId === bid).map(([k, v]) => ({ id: k.split("/")[1], ...v }));

async function trialBusiness(businessId, planId = "distributor-basic", workspaceTemplateId = "distributor") {
  await createBusiness({ ...world, name: businessId, planId, workspaceTemplateId, businessId, trial: true, clock: NOW });
  for (const [key, role] of [["owner", "owner"], ["staff", "manager"]]) {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@${businessId}.test`, name: key });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" }).catch(() => {});
    u[`${businessId}:${key}`] = x.uid;
  }
  return u[`${businessId}:owner`];
}
// Ends the trial: its dates move into the past (the data is untouched).
function endTrial(businessId, daysAgo = 2) {
  const b = biz(businessId);
  world.db.docs.set(`businesses/${businessId}`, { ...b, subscription: { ...b.subscription, ...newTrial(shift(TODAY, -(TRIAL_DAYS + daysAgo - 1)), TRIAL_DAYS) } });
}

describe("trial state (shared/trial.js)", () => {
  it("30 days, day 1 … 30; ended after the last day; Day 21 feedback prompt, Day 27 quiet reminder, never after feedback", () => {
    const t = newTrial("2026-10-01");
    expect(t).toEqual({ trialStatus: "trial_active", trialStartedAt: "2026-10-01", trialEndsAt: "2026-10-30" });
    const at = (day) => trialState(t, day);
    expect(at("2026-10-01")).toMatchObject({ status: "trial_active", day: 1, daysLeft: 29, open: true, ended: false });
    expect(at("2026-10-30")).toMatchObject({ status: "trial_active", day: 30, daysLeft: 0 });
    expect(at("2026-10-31")).toMatchObject({ status: "trial_ended", stored: "trial_active", ended: true, open: true });
    expect(trialState({ ...t, trialStatus: "converted" }, "2026-12-01")).toMatchObject({ status: "converted", open: false, ended: false });
    expect(trialState({ planId: "x" }, "2026-10-01")).toBeNull();
    expect(feedbackPrompt(at("2026-10-20"))).toBeNull(); // day 20
    expect(feedbackPrompt(at("2026-10-21"))).toBe("prompt"); // day 21
    expect(feedbackPrompt(at("2026-10-27"))).toBe("reminder"); // day 27
    expect(feedbackPrompt(at("2026-10-21"), { submitted: true })).toBeNull();
    expect(feedbackPrompt(trialState({ ...t, trialStatus: "converted" }, "2026-10-25"))).toBeNull();
  });
});

describe("a free trial is never a bill", () => {
  it("Luna Distributor starts with 30 days free: nothing due, no ₱0 bill; Super Admin sees 'Free trial' and the end date", async () => {
    const owner = await trialBusiness("dist-trial");
    expect(biz("dist-trial").subscription).toMatchObject({ trialStatus: "trial_active", trialStartedAt: TODAY, trialEndsAt: shift(TODAY, 29), conversion: null, setupFee: 25000, setupFeeBilled: false });
    expect(subscriptionTerms(biz("dist-trial").subscription)).toMatchObject({ dueDate: null, awaitingConversion: true });
    expect(billFor(biz("dist-trial"), currentPeriod(NOW))).toBeNull();
    const s = ok(await sub("dist-trial", owner)).subscription;
    expect(s.trial).toMatchObject({ status: "trial_active", day: 1, daysLeft: 29 });
    expect(s.openInvoices).toEqual([]);
    expect(s.options).toEqual([{ planId: "distributor-basic", name: "Luna Distributor", tagline: expect.any(String), current: true, priceIsMinimum: false, setupFee: 25000, terms: [{ months: 6, price: 129900, label: "6 months · ₱1,299", bestValue: false }, { months: 12, price: 239000, label: "12 months · ₱2,390 · Best Value", bestValue: true }] }]);
    expect(invoices("dist-trial")).toEqual([]);
    const row = ok(await op({ action: "business", businessId: "dist-trial" })).billing;
    expect(row).toMatchObject({ state: "trial", trial: { endsAt: shift(TODAY, 29), open: true }, dueDate: null, attention: null });
    // A week before the end: "Trial ends soon".
    endTrial("dist-trial", -5);
    expect(ok(await op({ action: "business", businessId: "dist-trial" })).billing.attention).toMatchObject({ kind: "trial", label: "Trial ends soon", what: "Trial ends" });
    const o = ok(await op({ action: "overview" })).overview;
    expect(o.trials).toMatchObject({ active: 1, endingSoon: 1 });
    expect(o.needsAttention.find((r) => r.id === "dist-trial").attention.kind).toBe("trial");
  });

  it("Household and Bridal: 30 days free, no setup fee; Luna Bridal is the one Bridal option; (legacy) Custom has no free trial", async () => {
    const h = await trialBusiness("home-trial", "household-basic", "household-payroll");
    expect(ok(await sub("home-trial", h)).subscription.options[0]).toMatchObject({ name: "Luna Household", setupFee: 0, terms: [{ months: 6, price: 129900 }, { months: 12, price: 239000, bestValue: true }] });
    const w = await trialBusiness("wed-trial", "bridal-basic", "bridal-expense");
    const opts = ok(await sub("wed-trial", w)).subscription.options;
    expect(opts.map((o) => [o.name, o.priceIsMinimum, o.terms.map((t) => t.price)])).toEqual([["Luna Bridal", false, [49900, 79900]]]);
    await createBusiness({ ...world, name: "Custom", planId: "bridal-plus", workspaceTemplateId: "bridal-expense", businessId: "wed-custom", trial: true, clock: NOW });
    expect(biz("wed-custom").subscription.trialStatus).toBeUndefined();
  });
});

describe("Continue with Luna", () => {
  it("the owner chooses 12 months: the first bill is ₱2,390 + ₱250 setup from the day after the trial; paying it converts the trial (same business, same data)", async () => {
    const owner = await trialBusiness("dist-c");
    ok(await customer("dist-c", owner, "Aling Nena Store"), 201);
    expect((await sub("dist-c", u["dist-c:staff"], { action: "choose", termMonths: 12 })).status).toBe(403);
    expect((await sub("dist-c", owner, { action: "choose", termMonths: 3 })).status).toBe(400);
    const r = ok(await sub("dist-c", owner, { action: "choose", termMonths: 12 }));
    const start = shift(TODAY, 30);
    expect(biz("dist-c").subscription).toMatchObject({ termMonths: 12, amount: 239000, startDate: start, conversion: { planId: "distributor-basic", termMonths: 12, startDate: start }, trialStatus: "trial_active" });
    expect(r.invoice).toMatchObject({ amountDue: 264000 });
    expect(r.invoice.lines.map((l) => [l.kind, l.amount])).toEqual([["base", 239000], ["setup", 25000]]);
    // Choosing again (6 months) before paying re-prices the same bill.
    const r6 = ok(await sub("dist-c", owner, { action: "choose", termMonths: 6 }));
    expect(r6.invoice.amountDue).toBe(154900);
    expect(invoices("dist-c")).toHaveLength(1);
    // Luna records the payment: converted; the setup fee is billed once.
    ok(await op({ action: "recordPayment", businessId: "dist-c", payment: { paymentDate: TODAY } }));
    const s = biz("dist-c").subscription;
    expect(s).toMatchObject({ trialStatus: "converted", setupFeeBilled: true });
    expect(s.paidThrough > start).toBe(true);
    expect(trialState(s, TODAY).status).toBe("converted");
    const renewal = subscriptionTerms(s);
    expect(billFor(biz("dist-c"), renewal.dueDate.slice(0, 7))).toMatchObject({ amountDue: 129900, lines: [{ kind: "base" }] });
    // The same workspace with its data.
    expect([...world.db.docs.keys()].some((k) => k.startsWith("businesses/dist-c/customers/"))).toBe(true);
    expect((await sub("dist-c", owner, { action: "choose", termMonths: 12 })).body.error).toBe("not-in-trial");
  });

  it("after the trial ends: nothing is deleted; reads, Continue, paying and Excel download work; everyday edits are refused; paying restores at once", async () => {
    const owner = await trialBusiness("dist-e");
    ok(await customer("dist-e", owner, "Before the end"), 201);
    endTrial("dist-e");
    const s = ok(await session("dist-e", owner)).subscription;
    expect(s.access).toMatchObject({ canRead: true, canWrite: false, trialEnded: true });
    expect(s.trial).toMatchObject({ status: "trial_ended", ended: true });
    const refused = await customer("dist-e", owner, "After the end");
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: "trial-ended", message: "Your Luna trial has ended. Your information is still safe. Choose a plan to continue using your workspace." });
    expect([...world.db.docs.keys()].filter((k) => k.startsWith("businesses/dist-e/customers/"))).toHaveLength(1);
    // Settings → Data: Download Excel still works.
    const x = await createWorkbookHandler(deps())({ ...request({ uid: owner, businessId: "dist-e", method: "POST" }), body: JSON.stringify({ range: "month" }) });
    expect(x.statusCode).toBe(200);
    // Choose (starts today, the trial is over) and pay.
    const r = ok(await sub("dist-e", owner, { action: "choose", termMonths: 6 }));
    expect(biz("dist-e").subscription.startDate).toBe(TODAY);
    expect(r.invoice.amountDue).toBe(154900);
    expect((await customer("dist-e", owner, "Still locked until paid")).status).toBe(403);
    ok(await op({ action: "recordPayment", businessId: "dist-e", payment: { paymentDate: TODAY } }));
    expect(ok(await session("dist-e", owner)).subscription.access).toMatchObject({ canWrite: true, trialEnded: false });
    ok(await customer("dist-e", owner, "Back to work"), 201);
  });
});

describe("Super Admin: convert and restart a trial", () => {
  it("convertTrial chooses for the customer; restartTrial gives fresh dates (audited); a paid workspace can't restart", async () => {
    const owner = await trialBusiness("home-op", "household-basic", "household-payroll");
    endTrial("home-op");
    expect((await op({ action: "restartTrial", businessId: "home-op", days: 14, reason: "x" })).status).toBe(400);
    ok(await op({ action: "restartTrial", businessId: "home-op", days: 14, reason: "Owner was in hospital" }));
    expect(biz("home-op").subscription).toMatchObject({ trialStatus: "reset", trialStartedAt: TODAY, trialEndsAt: shift(TODAY, 13), conversion: null });
    expect(ok(await session("home-op", owner)).subscription.access.canWrite).toBe(true);
    ok(await op({ action: "convertTrial", businessId: "home-op", termMonths: 12, reason: "Paid by bank transfer" }));
    expect(biz("home-op").subscription.conversion).toMatchObject({ termMonths: 12, startDate: shift(TODAY, 14) });
    ok(await op({ action: "recordPayment", businessId: "home-op", payment: { paymentDate: TODAY } }));
    expect(biz("home-op").subscription.trialStatus).toBe("converted");
    expect((await op({ action: "restartTrial", businessId: "home-op", days: 30, reason: "Try again please" })).status).toBe(400);
    const audits = [...world.db.docs.values()].filter((v) => v?.businessId === "home-op" && /trial-restarted|conversion-chosen/.test(v.type ?? ""));
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });
});

// Bridal pricing (2026-10-26): 3 months ₱499 or 6 months ₱799, the same
// features; the Premium wedding link (+₱499) is a flat add-on billed once
// on its own bill, never inside a term bill.
import { planBilling, billLines, addOnAmount } from "../../shared/plan-billing.js";
import { PLAN_SEED } from "../../shared/plans.seed.js";
describe("Bridal pricing 2026-10-26", () => {
  it("3 months ₱499 · 6 months ₱799; the Premium wedding link is +₱499 once and grants the custom link", () => {
    const b = planBilling(PLAN_SEED["bridal-basic"]);
    expect(b.type).toBe("term");
    expect(b.terms.map((t) => [t.months, t.price])).toEqual([[3, 49900], [6, 79900]]);
    expect(b.defaultTermMonths).toBe(3);
    expect(b.addOns).toEqual([expect.objectContaining({ id: "premium-link", price: 49900, flat: true, grants: "customLink" })]);
  });
  it("a flat add-on is never prorated or added to a term bill", () => {
    const premium = { id: "premium-link", label: "Premium wedding link", price: 49900, qty: 1, flat: true, grants: "customLink" };
    expect(addOnAmount([premium], 6)).toBe(0);
    const lines = billLines({ billingType: "term", amount: 79900, termMonths: 6, addOns: [premium] }, { planName: "Luna Bridal" });
    expect(lines.map((l) => l.kind)).toEqual(["base"]);
    expect(lines[0].amount).toBe(79900);
  });
});
