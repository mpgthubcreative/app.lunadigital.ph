// Phase 18.6 Luna subscription payments on the REAL Firestore emulator:
// confirm racing confirm / reject decides exactly once (one credit, one
// renewal move, one revenue count, one audit), and the counters stay equal
// to a recount.

import { beforeAll, describe, it, expect, vi } from "vitest";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });

const NOW = new Date("2026-10-16T04:00:00Z");
let db, admin, FieldValue, billing, prov;
let run = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const fa = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin } = await fa.getAdmin());
  FieldValue = admin.firestore.FieldValue;
  billing = await import("../../netlify/functions/_lib/billing.js");
  prov = await import("../../netlify/functions/_lib/provisioning.js");
  await prov.seedPlans({ db, admin, overwrite: true });
});

// A business with its October bill and one submitted payment (seeded
// directly: the proof upload isn't part of the race).
async function world(amount = 29900) {
  run += 1;
  const id = `bill-${Date.now().toString(36)}-${run}`;
  await prov.createBusiness({ db, admin, name: `Billing ${run}`, planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: id });
  // A ₱299 calendar-month subscription (the shape from before billing types):
  // these tests are about races, not the billing model (super-admin.test.js).
  await db.doc(`businesses/${id}`).update({ subscription: { planId: "household-plus", status: "past_due", renewalAt: null, graceUntil: null, monthlyAmount: 29900, paidThrough: null, nextRenewal: null } });
  await billing.ensureInvoice({ db, FieldValue, businessId: id, period: "2026-10" });
  const paymentId = `sp${id.replace(/[^a-z0-9]/g, "")}`.slice(0, 40);
  await db.doc(`subscriptionPayments/${paymentId}`).set({ businessId: id, businessName: id, workspaceTemplateId: "household-payroll", planId: "household-plus", planNameSnapshot: "Household Plus", period: "2026-10", invoiceId: `${id}_2026-10`, amountDue: 29900, amountSubmitted: amount, method: "bank_transfer", paymentDate: "2026-10-15", reference: "BT", status: "for_verification", submittedAt: FieldValue.serverTimestamp() });
  await db.doc(`subscriptionInvoices/${id}_2026-10`).update({ status: "for_verification", paymentIds: [paymentId] });
  return { id, paymentId };
}
const audits = async (id, type) => (await db.collection("platformAudit").where("businessId", "==", id).get()).docs.map((d) => d.data()).filter((a) => a.type === type);

describe("confirm / reject races", () => {
  it("five confirms at once (double clicks, two operators): one credit, one renewal move, one audit", async () => {
    const w = await world();
    const before = (await db.doc("platformMetrics/2026-10").get()).data()?.verifiedRevenue ?? 0;
    const r = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => billing.confirmPayment({ db, FieldValue, paymentId: w.paymentId, operator: `op${i}`, now: NOW })));
    const decided = r.filter((x) => x.status === "fulfilled" && !x.value.alreadyDecided);
    expect(decided).toHaveLength(1);
    for (const x of r) if (x.status === "rejected") expect(String(x.reason?.code ?? x.reason?.message)).toMatch(/ABORTED|10|contention|too much/i);
    const inv = (await db.doc(`subscriptionInvoices/${w.id}_2026-10`).get()).data();
    expect(inv).toMatchObject({ amountPaid: 29900, status: "paid" });
    expect((await db.doc(`businesses/${w.id}`).get()).data().subscription).toMatchObject({ status: "active", paidThrough: "2026-10-31", nextRenewal: "2026-11-01" });
    expect((await db.doc("platformMetrics/2026-10").get()).data().verifiedRevenue - before).toBe(29900);
    expect(await audits(w.id, "subscription.payment-confirmed")).toHaveLength(1);
  });

  it("confirm racing reject: exactly one wins; never both a credit and a rejection", async () => {
    for (let i = 0; i < 3; i++) {
      const w = await world();
      const r = await Promise.allSettled([billing.confirmPayment({ db, FieldValue, paymentId: w.paymentId, operator: "a", now: NOW }), billing.rejectPayment({ db, FieldValue, paymentId: w.paymentId, operator: "b", reason: "Wrong account" })]);
      expect(r.filter((x) => x.status === "fulfilled" && !x.value.alreadyDecided)).toHaveLength(1);
      const p = (await db.doc(`subscriptionPayments/${w.paymentId}`).get()).data();
      const inv = (await db.doc(`subscriptionInvoices/${w.id}_2026-10`).get()).data();
      if (p.status === "paid") expect(inv).toMatchObject({ amountPaid: 29900, status: "paid" });
      else expect(p.status === "rejected" && inv.amountPaid === 0 && inv.status === "due").toBe(true);
      expect((await audits(w.id, "subscription.payment-confirmed")).length + (await audits(w.id, "subscription.payment-rejected")).length).toBe(1);
    }
  });

  it("the billing run racing itself bills each business once", async () => {
    const w = await world();
    const period = "2027-03";
    await Promise.allSettled([billing.ensureInvoice({ db, FieldValue, businessId: w.id, period }), billing.ensureInvoice({ db, FieldValue, businessId: w.id, period }), billing.ensureInvoice({ db, FieldValue, businessId: w.id, period })]);
    const inv = await db.doc(`subscriptionInvoices/${w.id}_${period}`).get();
    expect(inv.exists).toBe(true);
    expect((await db.doc(`platformMetrics/${period}`).get()).data().invoicesCreated).toBe(1);
  });
});
