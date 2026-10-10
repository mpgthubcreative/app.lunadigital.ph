// Payment concurrency on the REAL Firestore + Storage emulators through the
// Admin SDK. Every outcome must be explicit (success, a domain refusal, or
// contention) and the stored order totals must equal the sum of the
// payments that actually exist.

import { beforeAll, describe, it, expect, vi } from "vitest";
import { QTY_SCALE } from "../../shared/quantity.js";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
process.env.FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || "demo-luna.appspot.com";
vi.setConfig({ testTimeout: 180000 });

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "conc-pay", name: "Concurrency", email: "" };
const NOW = new Date("2026-10-08T02:00:00Z");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
let db, bucket, FieldValue, inv, orders, pay, tenantDb;
let run = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const admin = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, bucket, admin: { firestore: { FieldValue } } } = await admin.getAdmin());
  inv = await import("../../netlify/functions/_lib/inventory.js");
  orders = await import("../../netlify/functions/_lib/orders.js");
  pay = await import("../../netlify/functions/_lib/payments.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
});

const CONTENDED = 10;
const settle = (p) => Promise.allSettled(p);
const ok = (r) => r.filter((x) => x.status === "fulfilled");
function expectExplicit(results, codes = []) {
  for (const r of results) if (r.status === "rejected") expect([CONTENDED, ...codes], String(r.reason && r.reason.message)).toContain(r.reason && r.reason.code);
}

async function world({ total = 1000000 } = {}) {
  run += 1;
  const id = `payc-${Date.now().toString(36)}-${run}`;
  const tenant = tenantDb(db, id);
  const business = { id, timezone: "Asia/Manila", orderPrefix: "PC" };
  // Phase 18: the effective limits (orders, file storage) are read from the business document.
  await tenant.ref.set({ timezone: "Asia/Manila", entitlements: { limits: { users: 5, ordersPerMonth: 1000, storageBytes: 1024 ** 3, importsPerMonth: 5 } } });
  const { productId } = await inv.createProduct({ db, tenant, FieldValue, actor, input: { sku: `P-${run}`, name: "Item", unit: "pcs", sellingPrice: total / 10, reorderLevel: 0 } });
  await inv.recordMovement({ db, tenant, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(100), unitCost: 100, note: "count" } });
  const { orderId } = await orders.createOrder({ db, tenant, FieldValue, business, entitlements: { limits: { ordersPerMonth: 1000 } }, input: { customer: { name: "Racer" }, source: "phone", items: [{ productId, quantity: Q(10) }] }, idempotencyKey: `payc-key-${id}`.padEnd(20, "x"), actor, canDiscount: false, now: NOW });
  return { tenant, business, orderId, productId };
}

const record = (w, input, { canVerify = true, proof = null, orderId = w.orderId } = {}) =>
  pay.recordPayment({ db, bucket, tenant: w.tenant, FieldValue, business: w.business, orderId, input, proof, actor, canVerify, now: NOW });

// The order's totals must equal its live payments.
async function consistent(w) {
  const order = (await w.tenant.doc("orders", w.orderId).get()).data();
  const live = (await w.tenant.collection("payments").where("orderId", "==", w.orderId).get()).docs.map((d) => d.data()).filter((p) => p.state !== "voided");
  const sum = (s) => live.filter((p) => s(p.state)).reduce((a, p) => a + p.amount, 0);
  expect(order.verifiedPaid).toBe(sum((s) => s === "verified"));
  expect(order.pendingPaid).toBe(sum((s) => s === "for_verification"));
  expect(order.amountPaid).toBe(order.verifiedPaid + order.pendingPaid);
  // A cancelled order owes nothing (cancel zeroes the balance; it is refused while payments exist).
  expect(order.balance).toBe(order.fulfillmentStatus === "cancelled" ? 0 : order.total - order.amountPaid);
  expect(order.amountPaid).toBeLessThanOrEqual(order.total);
  return { order, live };
}

describe("the required scenario on the real emulator", () => {
  it("₱10,000 order: ₱4,000 then ₱6,000 → Partially Paid then Paid; sales untouched until fulfilment", async () => {
    const w = await world();
    await record(w, { amount: 400000, method: "gcash", reference: "1111 2222 3" });
    expect((await consistent(w)).order).toMatchObject({ paymentStatus: "partial", balance: 600000 });
    await record(w, { amount: 600000, method: "cash" });
    expect((await consistent(w)).order).toMatchObject({ paymentStatus: "paid", balance: 0, amountPaid: 1000000 });
    const fin = (await w.tenant.doc("financialMetrics", "2026-10-08").get()).data() || {};
    expect(fin.paymentsReceived).toBe(1000000);
    expect(fin.grossSales || 0).toBe(0);
    expect(fin.cogs || 0).toBe(0);
  });
});

describe("races", () => {
  it("two payments against the same remaining balance: never overpaid", async () => {
    const w = await world();
    const results = await settle([record(w, { amount: 700000, method: "cash" }), record(w, { amount: 700000, method: "cash" })]);
    expectExplicit(results, ["overpayment"]);
    expect(ok(results)).toHaveLength(1);
    const { live } = await consistent(w);
    expect(live).toHaveLength(1);
  });

  it("two users marking the same order Paid (full balance each): exactly one payment", async () => {
    const w = await world();
    const results = await settle(Array.from({ length: 4 }, () => record(w, { amount: 1000000, method: "cash" })));
    expectExplicit(results, ["overpayment"]);
    expect(ok(results)).toHaveLength(1);
    expect((await consistent(w)).order.paymentStatus).toBe("paid");
  });

  it("the same reference submitted at once on two orders: one wins, the other is a duplicate", async () => {
    const w = await world();
    const other = await (async () => {
      const { orderId } = await orders.createOrder({ db, tenant: w.tenant, FieldValue, business: w.business, entitlements: { limits: { ordersPerMonth: 1000 } }, input: { customer: { name: "Second" }, source: "phone", items: [{ productId: w.productId, quantity: Q(1) }] }, idempotencyKey: `payc-key2-${run}-${Date.now()}`.padEnd(20, "x"), actor, canDiscount: false, now: NOW });
      return orderId;
    })();
    const results = await settle([record(w, { amount: 50000, method: "gcash", reference: "ABC123" }), record(w, { amount: 50000, method: "gcash", reference: "abc-123" }, { orderId: other })]);
    expectExplicit(results, ["duplicate-reference"]);
    expect(ok(results)).toHaveLength(1);
    expect((await w.tenant.collection("payments").where("reference", "==", "ABC123").get()).size).toBe(1);
    expect((await w.tenant.doc("paymentRefs", "gcash_ABC123").get()).exists).toBe(true);
  });

  it("the same reference in another business is fine", async () => {
    const [a, b] = [await world(), await world()];
    await record(a, { amount: 50000, method: "gcash", reference: "ABC123" });
    await expect(record(a, { amount: 50000, method: "gcash", reference: "ABC123" })).rejects.toMatchObject({ code: "duplicate-reference", message: "This payment reference has already been used." });
    await expect(record(b, { amount: 50000, method: "gcash", reference: "ABC123" })).resolves.toMatchObject({ paymentStatus: "partial" });
  });

  it("correction vs correction on one payment: both apply in some order, totals stay exact", async () => {
    const w = await world();
    const { paymentId } = await record(w, { amount: 400000, method: "gcash", reference: "REF00001" });
    const edit = (changes) => pay.updatePayment({ db, bucket, tenant: w.tenant, FieldValue, business: w.business, paymentId, changes, actor });
    const results = await settle([edit({ amount: 450000 }), edit({ reference: "REF00002" })]);
    expectExplicit(results);
    const { live } = await consistent(w);
    const p = live[0];
    if (results[0].status === "fulfilled") expect(p.amount).toBe(450000);
    if (results[1].status === "fulfilled") {
      expect(p.reference).toBe("REF00002");
      expect((await w.tenant.doc("paymentRefs", "gcash_REF00001").get()).exists).toBe(false);
    }
    const day = (await w.tenant.doc("financialMetrics", "2026-10-08").get()).data();
    expect(day.paymentsReceived).toBe(p.amount);
  });

  it("payment vs order correction that lowers the total: never total < paid", async () => {
    const w = await world();
    await orders.fulfillOrder({ db, tenant: w.tenant, FieldValue, business: w.business, orderId: w.orderId, actor, now: NOW });
    const results = await settle([
      record(w, { amount: 900000, method: "cash" }),
      orders.updateOrder({ db, tenant: w.tenant, FieldValue, business: w.business, orderId: w.orderId, input: { customer: { name: "Racer" }, source: "phone", items: [{ productId: w.productId, quantity: Q(5) }] }, reason: "Customer took 5", actor, canDiscount: false, canCorrect: true }),
    ]);
    expectExplicit(results, ["overpayment", "below-paid"]);
    expect(ok(results).length).toBeGreaterThanOrEqual(1);
    await consistent(w);
  });

  it("payment vs cancellation: either a cancelled order with no payment, or a paid order still open", async () => {
    const w = await world();
    const results = await settle([
      record(w, { amount: 200000, method: "cash" }),
      orders.cancelOrder({ db, tenant: w.tenant, FieldValue, business: w.business, orderId: w.orderId, reason: "race test", actor, now: NOW }),
    ]);
    expectExplicit(results, ["order-cancelled", "has-payments"]);
    expect(ok(results)).toHaveLength(1);
    const { order, live } = await consistent(w);
    if (order.fulfillmentStatus === "cancelled") expect(live).toHaveLength(0);
    else expect(live).toHaveLength(1);
  });

  it("void vs record: the freed balance is reused at most once", async () => {
    const w = await world();
    const { paymentId } = await record(w, { amount: 1000000, method: "cash" });
    const results = await settle([
      pay.voidPayment({ db, tenant: w.tenant, FieldValue, business: w.business, paymentId, reason: "entered twice", actor }),
      record(w, { amount: 1000000, method: "cash" }),
    ]);
    expectExplicit(results, ["overpayment"]);
    await consistent(w);
  });
});

describe("proofs on the Storage emulator", () => {
  it("stored under the tenant's prefix, no download token, readable only through its own business", async () => {
    const w = await world();
    const { paymentId } = await record(w, { amount: 100000, method: "gcash", reference: "PROOF0001" }, { proof: { contentType: "image/png", dataBase64: PNG.toString("base64") } });
    const p = (await w.tenant.doc("payments", paymentId).get()).data();
    expect(p.proof.path.startsWith(`tenants/${w.business.id}/payments/proofs/${w.orderId}/`)).toBe(true);
    const [meta] = await (await bucket()).file(p.proof.path).getMetadata();
    expect(meta.metadata?.firebaseStorageDownloadTokens).toBeUndefined();
    expect(meta.contentType).toBe("image/png");
    const mine = await pay.readProof({ tenant: w.tenant, bucket, businessId: w.business.id, paymentId });
    expect(Buffer.from(mine.dataBase64, "base64").equals(PNG)).toBe(true);
    const other = await world();
    await expect(pay.readProof({ tenant: other.tenant, bucket, businessId: other.business.id, paymentId })).rejects.toMatchObject({ code: "not-found" });
  });

  it("a refused payment leaves no orphan file", async () => {
    const w = await world();
    await record(w, { amount: 50000, method: "gcash", reference: "ORPHAN01" });
    await expect(record(w, { amount: 50000, method: "gcash", reference: "ORPHAN01" }, { proof: { contentType: "image/png", dataBase64: PNG.toString("base64") } })).rejects.toMatchObject({ code: "duplicate-reference" });
    const [files] = await (await bucket()).getFiles({ prefix: `tenants/${w.business.id}/payments/` });
    expect(files).toHaveLength(0);
  });
});
