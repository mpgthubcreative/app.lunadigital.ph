// Reseller commission under concurrency on the REAL Firestore emulator
// (Admin SDK): however payouts and commission changes interleave, a
// reseller is never paid more than earned (no negative remaining), earned
// always equals the sum of EARNED commission on their live orders (final ×
// verified customer payments ÷ total, 2026-11-01), and every failure is
// explicit (a domain refusal or contention).

import { beforeAll, describe, it, expect, vi } from "vitest";
import { QTY_SCALE } from "../../shared/quantity.js";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
process.env.FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || "demo-luna.appspot.com";
vi.setConfig({ testTimeout: 180000 });

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "conc-res", name: "Concurrency", email: "" };
const NOW = new Date("2026-10-15T02:00:00Z");
let db, FieldValue, inv, orders, rs, pay, tenantDb, computeEntitlements, PLAN_SEED, earnedOf;
let run = 0;
let keySeq = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const admin = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin: { firestore: { FieldValue } } } = await admin.getAdmin());
  inv = await import("../../netlify/functions/_lib/inventory.js");
  orders = await import("../../netlify/functions/_lib/orders.js");
  rs = await import("../../netlify/functions/_lib/resellers.js");
  pay = await import("../../netlify/functions/_lib/payments.js");
  ({ earnedOf } = await import("../../shared/resellers.js"));
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
  ({ computeEntitlements, PLAN_SEED } = await import("../../shared/index.js"));
});

const CONTENDED = 10;
const settle = (p) => Promise.allSettled(p);
const ok = (r) => r.filter((x) => x.status === "fulfilled");
function expectExplicit(results, codes = []) {
  for (const r of results) if (r.status === "rejected") expect([CONTENDED, "commission-overpaid", "commission-below-paid", "overpayment", ...codes], String(r.reason && r.reason.message)).toContain(r.reason && r.reason.code);
}
const key = () => `res-conc-${Date.now().toString(36)}-${++keySeq}`.padEnd(20, "x");

async function world() {
  run += 1;
  const id = `resc-${Date.now().toString(36)}-${run}`;
  const tenant = tenantDb(db, id);
  const business = { id, timezone: "Asia/Manila", orderPrefix: "RS" };
  const entitlements = computeEntitlements(PLAN_SEED["reseller-basic"], {}, "reseller");
  const { productId } = await inv.createProduct({ db, tenant, FieldValue, actor, input: { sku: `R-${run}`, name: "Item", unit: "pcs", sellingPrice: 50000, reorderLevel: 0 } });
  await inv.recordMovement({ db, tenant, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(1000), unitCost: 0, note: "count" } });
  const { resellerId } = await rs.createReseller({ db, tenant, FieldValue, input: { name: "Riza" }, actor, now: NOW });
  // The customer pays the business (verified unless verify: false).
  const customerPays = (orderId, amount, verify = true) => pay.recordPayment({ db, bucket: null, tenant, FieldValue, business, orderId, input: { amount, method: "cash", reference: `CASH${String(++keySeq).padStart(5, "0")}R${run}` }, actor, canVerify: verify, now: NOW });
  const sale = (qty = 2) => orders.createOrder({ db, tenant, FieldValue, business, entitlements, input: { customer: { name: "Marian", phone: "", notes: "" }, source: "other", sourceNote: "Reseller · Riza", items: [{ productId, quantity: Q(qty) }] }, idempotencyKey: key(), actor, canDiscount: false, reseller: { id: resellerId, name: "Riza", prices: new Map([[productId, 65000]]) }, now: NOW });
  const paidSale = async (qty = 2) => {
    const r = await sale(qty);
    await customerPays(r.orderId, qty * 65000);
    return r;
  };
  return { tenant, business, productId, resellerId, sale, paidSale, customerPays };
}
const reseller = async (w) => (await w.tenant.doc("resellers", w.resellerId).get()).data();
const liveFinals = async (w) => (await w.tenant.collection("orders").where("resellerId", "==", w.resellerId).get()).docs.map((d) => d.data()).reduce((t, o) => t + earnedOf(o), 0);

describe("commission payouts under concurrency", () => {
  it("eight payouts of the full remaining at once: exactly one is recorded; never overpaid", async () => {
    const w = await world();
    await w.paidSale(); // ₱300 commission, earned in full
    const results = await settle(Array.from({ length: 8 }, () => rs.payCommission({ db, tenant: w.tenant, FieldValue, business: w.business, resellerId: w.resellerId, input: { amount: 30000 }, idempotencyKey: key(), actor, now: NOW })));
    expectExplicit(results);
    expect(ok(results)).toHaveLength(1);
    const r = await reseller(w);
    expect(r).toMatchObject({ earned: 30000, paid: 30000 });
    expect((await w.tenant.collection("commissionPayouts").get()).size).toBe(1);
  });

  it("payouts racing an override that lowers the commission: paid never exceeds earned; earned = Σ final", async () => {
    const w = await world();
    const { orderId } = await w.paidSale(); // ₱300
    const results = await settle([
      ...Array.from({ length: 4 }, () => rs.payCommission({ db, tenant: w.tenant, FieldValue, business: w.business, resellerId: w.resellerId, input: { amount: 10000 }, idempotencyKey: key(), actor, now: NOW })),
      orders.editResellerSale({ db, tenant: w.tenant, FieldValue, orderId, finalCommission: 15000, actor, now: NOW }),
      orders.editResellerSale({ db, tenant: w.tenant, FieldValue, orderId, finalCommission: 25000, actor, now: NOW }),
    ]);
    expectExplicit(results, ["stale-order"]);
    const r = await reseller(w);
    expect(r.paid).toBeLessThanOrEqual(r.earned);
    expect(r.earned).toBe(await liveFinals(w));
    const ledger = (await w.tenant.collection("commissionPayouts").get()).docs.map((d) => d.data()).filter((p) => p.state === "paid").reduce((t, p) => t + p.amount, 0);
    expect(r.paid).toBe(ledger);
  });

  it("new reseller orders racing payouts and a cancel: the totals always match the orders and the ledger", async () => {
    const w = await world();
    const first = await w.sale(1); // ₱150 potential, unpaid
    await w.paidSale(1); // ₱150 earned, so a payout has something to pay
    const results = await settle([
      w.paidSale(2),
      w.sale(3),
      rs.payCommission({ db, tenant: w.tenant, FieldValue, business: w.business, resellerId: w.resellerId, input: { amount: 15000 }, idempotencyKey: key(), actor, now: NOW }),
      orders.cancelOrder({ db, tenant: w.tenant, FieldValue, business: w.business, orderId: first.orderId, reason: "Customer backed out", actor, now: NOW }),
    ]);
    expectExplicit(results);
    const r = await reseller(w);
    expect(r.earned).toBe(await liveFinals(w));
    expect(r.paid).toBeLessThanOrEqual(r.earned);
  });

  it("customer payments, a refund and payouts racing: earned always = final × verified ÷ total; never paid more than earned", async () => {
    const w = await world();
    const { orderId } = await w.sale(2); // ₱1,300 order, ₱300 potential
    const first = await w.customerPays(orderId, 26000); // 20% → ₱60
    const results = await settle([
      w.customerPays(orderId, 26000),
      w.customerPays(orderId, 26000, false), // pending: never counts
      w.customerPays(orderId, 26000),
      rs.payCommission({ db, tenant: w.tenant, FieldValue, business: w.business, resellerId: w.resellerId, input: { amount: 6000 }, idempotencyKey: key(), actor, now: NOW }),
      rs.payCommission({ db, tenant: w.tenant, FieldValue, business: w.business, resellerId: w.resellerId, input: { amount: 6000 }, idempotencyKey: key(), actor, now: NOW }),
      pay.voidPayment({ db, tenant: w.tenant, FieldValue, business: w.business, paymentId: first.paymentId, reason: "Refunded", actor }),
    ]);
    expectExplicit(results, ["duplicate-reference"]);
    const r = await reseller(w);
    const o = (await w.tenant.doc("orders", orderId).get()).data();
    expect(r.earned).toBe(earnedOf(o));
    expect(r.earned).toBe(await liveFinals(w));
    expect(r.paid).toBeLessThanOrEqual(r.earned);
    const ledger = (await w.tenant.collection("commissionPayouts").get()).docs.map((d) => d.data()).filter((p) => p.state === "paid").reduce((t, p) => t + p.amount, 0);
    expect(r.paid).toBe(ledger);
  });
});
