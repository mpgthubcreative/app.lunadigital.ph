// Super Admin payment review (2026-10-28): a customer's payment shows in
// Payments, on the Overview's "Payments to review" and on the Business
// detail; what it pays for comes from its BILL (₱499 is both Luna Bridal —
// 3 Months and the Premium wedding link add-on). Sending a screenshot
// grants nothing; Luna's one explicit Verify records the money (collected)
// and applies what the bill covers, once. Verified payments leave the queue
// (they stay in Payments' history).

import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { createSubscriptionHandler } from "../../netlify/functions/subscription.js";
import { createBusiness, addMember, ensureAuthUser, setOperator } from "../../netlify/functions/_lib/provisioning.js";
import { createAddOnBill } from "../../netlify/functions/_lib/billing.js";
import { billProduct } from "../../shared/billing.js";
import { businessDate } from "../../shared/metrics.js";

const NOW = new Date();
const TODAY = businessDate("Asia/Manila", NOW);
const W = "yanie-review";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]).toString("base64");
let world;
const u = {};

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Yanie Bridal", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W, trial: true, clock: NOW });
  const o = await ensureAuthUser({ auth: world.auth, email: "yanie@review.test", name: "Yanie" });
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
const owner = async (body) => parse(await createSubscriptionHandler(deps())({ ...request({ uid: u.owner, businessId: W, method: "POST" }), body: JSON.stringify(body) }));
let k = 0;
const submit = (bill, extra = {}) => owner({ action: "submit", idempotencyKey: `review-key-${String(++k).padStart(8, "0")}`, payment: { period: bill.period, invoiceId: bill.id, amount: bill.amountDue, paymentDate: TODAY, reference: "GC-77", ...extra }, proof: { contentType: "image/png", dataBase64: PNG } });
const sub = () => world.db.docs.get(`businesses/${W}`).subscription;
const overview = async () => ok(await op({ action: "overview" })).overview;
const billsOf = () => [...world.db.docs.entries()].filter(([key, v]) => key.startsWith("subscriptionInvoices/") && v.businessId === W).map(([key, v]) => ({ id: key.split("/")[1], ...v }));

describe("billProduct: what a bill is for", () => {
  it("names access by its months and an add-on by its line; never by the amount", () => {
    expect(billProduct({ billingType: "term", months: 3, planName: "Luna Bridal", amountDue: 49900 })).toEqual({ kind: "access", label: "Luna Bridal — 3 Months", months: 3, does: "activate" });
    expect(billProduct({ billingType: "term", months: 6, planName: "Luna Bridal", amountDue: 79900 }).label).toBe("Luna Bridal — 6 Months");
    expect(billProduct({ kind: "addon", billingType: "term", amountDue: 49900, lines: [{ kind: "addon", addOnId: "premium-link", label: "Premium wedding link", amount: 49900 }] })).toEqual({ kind: "addon", label: "Premium wedding link add-on", months: 0, addOnId: "premium-link", does: "unlock" });
    expect(billProduct({ billingType: "monthly", months: 1, planName: "Growth" }).does).toBe("credit");
  });
});

describe("a customer payment, from submitted to verified", () => {
  it("submitted: in Payments, on the Overview queue and the Business detail, named by its bill; nothing is activated or collected yet", async () => {
    const chosen = ok(await owner({ action: "choose", termMonths: 3 }));
    const bill = billsOf()[0];
    expect(chosen.invoice.amountDue).toBe(49900);
    const sent = ok(await submit(bill), 201);
    // The screenshot alone grants nothing: still the trial, nothing collected.
    expect(sub().trialStatus).not.toBe("converted");
    expect(sub().paidThrough ?? null).toBeNull();
    let o = await overview();
    expect(o.collectedThisMonth).toBe(0);
    expect(o.awaiting).toEqual({ count: 1, amount: 49900 });
    expect(o.toReview).toHaveLength(1);
    expect(o.toReview[0]).toMatchObject({ id: sent.paymentId, businessId: W, businessName: "Yanie Bridal", amountSubmitted: 49900, method: "bank_transfer", status: "for_verification", product: { kind: "access", label: "Luna Bridal — 3 Months", does: "activate" } });
    expect(ok(await op({ action: "payments", filters: { status: "for_verification" } })).rows.map((r) => r.id)).toEqual([sent.paymentId]);
    expect(ok(await op({ action: "business", businessId: W })).latestPayment).toMatchObject({ id: sent.paymentId, status: "for_verification", product: { label: "Luna Bridal — 3 Months" } });
    // Review: the product, what's expected vs sent, the proof, the access now.
    const d = ok(await op({ action: "payment", paymentId: sent.paymentId }));
    expect(d.product).toMatchObject({ kind: "access", label: "Luna Bridal — 3 Months", months: 3, does: "activate" });
    expect(d.payment).toMatchObject({ amountDue: 49900, amountSubmitted: 49900, reference: "GC-77", method: "bank_transfer", hasProof: true });
    expect(d.access).toMatchObject({ billingType: "term", trial: { ended: false } });

    // Verify (one explicit action): collected once, the 3 months activated, out of the queue.
    const v = ok(await op({ action: "confirmPayment", paymentId: sent.paymentId }));
    expect(v.changed).toMatchObject({ does: "activate", label: "Luna Bridal — 3 Months" });
    expect(sub()).toMatchObject({ trialStatus: "converted", termMonths: 3 });
    expect(sub().paidThrough).toBe(v.changed.until);
    o = await overview();
    expect(o.collectedThisMonth).toBe(49900);
    expect(o.toReview).toEqual([]);
    expect(o.awaiting).toEqual({ count: 0, amount: 0 });
    expect(ok(await op({ action: "business", businessId: W })).latestPayment).toMatchObject({ status: "paid" });
    // History keeps it; a second Verify changes nothing (no duplicate payment or access change).
    expect(ok(await op({ action: "payments", filters: { businessId: W } })).rows).toHaveLength(1);
    const again = ok(await op({ action: "confirmPayment", paymentId: sent.paymentId }));
    expect(again.alreadyDecided).toBe(true);
    expect((await overview()).collectedThisMonth).toBe(49900);
    expect(sub().paidThrough).toBe(v.changed.until);
  });

  it("the ₱499 Premium wedding link is never taken for 3 months: its own product; Verify unlocks the add-on and leaves the access dates", async () => {
    ok(await owner({ action: "choose", termMonths: 3 }));
    const first = ok(await submit(billsOf()[0]), 201);
    ok(await op({ action: "confirmPayment", paymentId: first.paymentId }));
    const before = { ...sub() };
    await createAddOnBill({ db: world.db, FieldValue: world.admin.firestore.FieldValue, businessId: W, addOnId: "premium-link", actor: { uid: u.owner } });
    const addon = billsOf().find((b) => b.kind === "addon");
    const sent = ok(await submit(addon), 201);
    const queued = (await overview()).toReview;
    expect(queued).toHaveLength(1);
    expect(queued[0].product).toMatchObject({ kind: "addon", label: "Premium wedding link add-on", does: "unlock" });
    expect(queued[0].amountSubmitted).toBe(49900);
    const v = ok(await op({ action: "confirmPayment", paymentId: sent.paymentId }));
    expect(v.changed).toEqual({ does: "unlock", label: "Premium wedding link add-on" });
    expect(sub().addOnsPaid).toEqual(["premium-link"]);
    expect(sub()).toMatchObject({ termMonths: 3, paidThrough: before.paidThrough, accessUntil: before.accessUntil });
    const o = await overview();
    expect(o.collectedThisMonth).toBe(99800);
    expect(o.addOnIncomeThisMonth).toBe(49900);
  });

  it("a rejected payment leaves the queue and is never collected", async () => {
    ok(await owner({ action: "choose", termMonths: 6 }));
    const sent = ok(await submit(billsOf()[0]), 201);
    expect((await overview()).toReview[0].product.label).toBe("Luna Bridal — 6 Months");
    ok(await op({ action: "rejectPayment", paymentId: sent.paymentId, reason: "Amount not received" }));
    const o = await overview();
    expect(o.toReview).toEqual([]);
    expect(o.collectedThisMonth).toBe(0);
    expect(sub().trialStatus).not.toBe("converted");
  });
});
