// Luna Bridal access (2026-10-26): Free Trial, ₱499 for 3 months, ₱799 for 6
// months. Super Admin's Access choice sets the authoritative entitlement in
// one write (badge, term, access end, the server's trial checks), and access
// is NOT payment: a term's price becomes a bill; only a recorded payment
// counts as collected.
//
// The mismatch it fixes: "Change access" changed the term / price but left
// subscription.trialStatus unconverted, so every trialOpen() check (badge,
// Continue with Luna, invitations, add-ons) still treated it as a trial.

import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { createSubscriptionHandler } from "../../netlify/functions/subscription.js";
import { createBusiness, addMember, ensureAuthUser, setOperator } from "../../netlify/functions/_lib/provisioning.js";
import { businessDate } from "../../shared/metrics.js";
import { addMonths, shiftDay, planBilling } from "../../shared/plan-billing.js";
import { PLAN_SEED } from "../../shared/plans.seed.js";

const NOW = new Date();
const TODAY = businessDate("Asia/Manila", NOW);
const W = "wed-access";
let world;
const u = {};

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Yanie Bridal", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W, trial: true, clock: NOW });
  const o = await ensureAuthUser({ auth: world.auth, email: "yanie@wed.test", name: "Yanie" });
  await addMember({ ...world, businessId: W, uid: o.uid, email: o.email, name: "Yanie", roleTemplate: "owner", isAccountOwner: true });
  u.owner = o.uid;
  const op = await ensureAuthUser({ auth: world.auth, email: "ops@luna.test", name: "Ops" });
  await setOperator({ ...world, email: op.email, status: "active", reason: "test operator" });
  u.ops = op.uid;
});

const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const op = async (body) => parse(await createOperatorHandler(deps())({ ...request({ uid: u.ops }), httpMethod: "POST", body: JSON.stringify(body) }));
const mine = async () => ok(parse(await createSubscriptionHandler(deps())({ ...request({ uid: u.owner, businessId: W, method: "GET" }) }))).subscription;
const sub = () => world.db.docs.get(`businesses/${W}`).subscription;
const row = async () => ok(await op({ action: "business", businessId: W })).billing;
const bills = () => [...world.db.docs.entries()].filter(([k, v]) => k.startsWith("subscriptionInvoices/") && v.businessId === W).map(([, v]) => v);
const paymentsOf = () => [...world.db.docs.entries()].filter(([k, v]) => k.startsWith("subscriptionPayments/") && v.businessId === W);
const collected = () => [...world.db.docs.entries()].filter(([k]) => k.startsWith("platformMetrics/") && !k.endsWith("/current")).reduce((t, [, v]) => t + (v.verifiedRevenue ?? 0), 0);
const end = (months) => shiftDay(addMonths(TODAY, months), -1);
const access = (a) => op({ action: "setTermAccess", businessId: W, access: a, reason: "Customer asked" });

describe("the Bridal offer", () => {
  it("Free trial, ₱499 for 3 months, ₱799 for 6 months; Premium wedding link +₱499 once; no 12-month term", () => {
    const b = planBilling(PLAN_SEED["bridal-basic"]);
    expect(b.type).toBe("term");
    expect(b.terms.map((t) => [t.months, t.price])).toEqual([[3, 49900], [6, 79900]]);
    expect(b.trialDays).toBe(30);
    expect(b.addOns).toEqual([expect.objectContaining({ id: "premium-link", price: 49900, flat: true, grants: "customLink" })]);
  });
});

describe("Super Admin → Access", () => {
  it("Free trial → 3 months: badge, term, price, access end and the server all agree; ₱499 is due, nothing collected", async () => {
    expect((await row()).state).toBe("trial");
    const r = ok(await access(3));
    expect(r.amountDue).toBe(49900);
    expect(sub()).toMatchObject({ trialStatus: "converted", status: "active", termMonths: 3, amount: 49900, startDate: TODAY, accessUntil: end(3), paidThrough: null, accessGrant: { months: 3, grantedAt: TODAY } });
    const b = await row();
    expect(b).toMatchObject({ state: "active", termMonths: 3, amount: 49900, accessUntil: end(3), accessPaid: 0 });
    expect(b.trial.open).toBe(false);
    // The Owner's page: no trial, the term, a ₱499 bill to pay.
    const m = await mine();
    expect(m.trial.open).toBe(false);
    expect(m.options).toEqual([]);
    expect(m.billing).toMatchObject({ type: "term", termMonths: 3, amount: 49900, accessUntil: end(3) });
    expect(m.openInvoices.map((i) => i.amountDue)).toEqual([49900]);
    // Access is not payment.
    expect(paymentsOf()).toHaveLength(0);
    expect(collected()).toBe(0);
  });

  it("Free trial → 6 months: ₱799, access for 6 months", async () => {
    ok(await access(6));
    expect(sub()).toMatchObject({ termMonths: 6, amount: 79900, accessUntil: end(6), trialStatus: "converted" });
    expect(bills().map((i) => i.amountDue)).toEqual([79900]);
    expect(collected()).toBe(0);
  });

  it("unpaid 3 → 6 re-prices the one bill; back to Free trial removes it (still to collect goes back to ₱0)", async () => {
    ok(await access(3));
    ok(await access(6));
    expect(bills().map((i) => i.amountDue)).toEqual([79900]);
    ok(await access("trial"));
    expect(sub()).toMatchObject({ trialStatus: "trial_active", accessGrant: null });
    expect((await row()).state).toBe("trial");
    expect(bills()).toHaveLength(0);
    expect(world.db.docs.get("platformMetrics/current").outstanding).toBe(0);
  });

  it("recording the payment collects ₱499 once and keeps the access end (no second term)", async () => {
    ok(await access(3));
    ok(await op({ action: "recordPayment", businessId: W, payment: { paymentDate: TODAY, reference: "GCash 1234" } }));
    expect(collected()).toBe(49900);
    expect(sub()).toMatchObject({ paidThrough: end(3), accessUntil: end(3), accessPaid: 49900 });
    expect((await row()).dueDate).toBeNull();
  });

  it("paid: a longer term bills only the difference; never back to the trial or a shorter term", async () => {
    ok(await access(3));
    ok(await op({ action: "recordPayment", businessId: W, payment: { paymentDate: TODAY } }));
    expect((await access("trial")).body.error).toBe("invalid-input");
    const up = ok(await access(6));
    expect(up.amountDue).toBe(30000);
    expect(sub()).toMatchObject({ termMonths: 6, accessUntil: end(6) });
    expect(collected()).toBe(49900);
    expect((await access(3)).body.error).toBe("invalid-input");
  });

  it("Change access can't set a wedding's term on its own (the old split state)", async () => {
    const r = await op({ action: "setAccess", businessId: W, changes: { termMonths: 6 }, reason: "test" });
    expect(r.status).toBe(400);
    expect(sub().trialStatus).toBe("trial_active");
  });

  it("is audited, and refuses what isn't sold", async () => {
    expect((await access(12)).body.error).toBe("invalid-input");
    expect((await access("forever")).status).toBe(400);
    ok(await access(3));
    const audit = [...world.db.docs.values()].filter((v) => v.type === "entitlements.access-set");
    expect(audit.length).toBeGreaterThan(0);
  });
});

describe("Collection KPI (2026-10-26): only paid payment records are collected", () => {
  const overview = async () => ok(await op({ action: "overview" })).overview;
  it("granted access, an unpaid bill and a leftover counter count nothing; the recorded payment counts once, by workspace and type", async () => {
    // A stale running counter (e.g. deleted test businesses' payments) is ignored.
    const period = TODAY.slice(0, 7);
    world.db.seed(`platformMetrics/${period}`, { period, verifiedRevenue: 19600700, revenueByWorkspace: { "bridal-expense": 8669900 }, revenueByBillingType: { term: 8669900 } });
    world.db.seed("platformMetrics/current", { outstanding: 770400, awaitingAmount: 0, awaitingCount: 0 });
    ok(await access(6));
    let o = await overview();
    expect(o.collectedThisMonth).toBe(0);
    expect(o.annualIncomeThisMonth).toBe(0);
    expect(o.incomeByWorkspace.find((w) => w.workspaceTemplateId === "bridal-expense").collected).toBe(0);
    ok(await op({ action: "recordPayment", businessId: W, payment: { paymentDate: TODAY } }));
    o = await overview();
    expect(o.collectedThisMonth).toBe(79900);
    expect(o.annualIncomeThisMonth).toBe(79900);
    expect(o.addOnIncomeThisMonth).toBe(0);
    expect(o.incomeByWorkspace.find((w) => w.workspaceTemplateId === "bridal-expense").collected).toBe(79900);
  });
});
