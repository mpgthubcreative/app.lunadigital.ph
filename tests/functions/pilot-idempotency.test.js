// Distributor pilot readiness (2026-10-25): a request sent again (double
// tap, slow network, browser retry, the same call twice at once) changes
// money and stock exactly once. The key is the client's; the protection is
// the server's.

import { describe, it, expect, beforeEach } from "vitest";
import { recordPayment, paymentIdForKey } from "../../netlify/functions/_lib/payments.js";
import { createOrder } from "../../netlify/functions/_lib/orders.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createCustomer } from "../../netlify/functions/_lib/customers.js";
import { createPaymentsHandler } from "../../netlify/functions/payments.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-owner", name: "Owner", email: "o@t.test" };
const BIZ = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" };
const NOW = new Date("2026-10-25T05:00:00Z");
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
let world;
let A;
let n = 0;
beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});
const docAt = (p) => world.db.docs.get(p);
const keys = (prefix) => [...world.db.docs.keys()].filter((k) => k.startsWith(prefix));
const key = () => `pilot-key-${String(++n).padStart(8, "0")}-${Date.now().toString(36)}`;

// A ₱1,000 order for a saved customer (so the customer's balance is tracked too).
async function order() {
  const { productId } = await createProduct({ db: world.db, tenant: A, FieldValue, actor, input: { sku: `SKU-${++n}`, name: "Siomai", unit: "pcs", sellingPrice: 100000, reorderLevel: 0 } });
  await recordMovement({ db: world.db, tenant: A, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(10), unitCost: 50000, note: "count" } });
  const { customerId } = await createCustomer({ db: world.db, tenant: A, FieldValue, actor, input: { name: `Buyer ${n}` } });
  const { orderId } = await createOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, entitlements: docAt("businesses/biz-a").entitlements, input: { customerId, customer: { name: `Buyer ${n}` }, source: "viber", items: [{ productId, quantity: Q(1) }] }, idempotencyKey: key(), actor, canDiscount: false, canLinkCustomers: true, now: NOW });
  return { orderId, productId, customerId };
}
const pay = (orderId, input, idempotencyKey, extra = {}) => recordPayment({ db: world.db, bucket: world.bucket, tenant: A, FieldValue, business: BIZ, orderId, input, actor, canVerify: true, now: NOW, idempotencyKey, ...extra });
const money = (orderId, customerId) => ({
  order: (({ amountPaid, balance, paymentStatus, paymentCount }) => ({ amountPaid, balance, paymentStatus, paymentCount }))(docAt(`businesses/biz-a/orders/${orderId}`)),
  customerOwes: docAt(`businesses/biz-a/customers/${customerId}`).stats.outstandingBalance,
  receivables: docAt("businesses/biz-a/financialMetrics/current").receivablesOutstanding,
  payments: keys("businesses/biz-a/payments/").length,
});

describe("Record payment: the same request twice is one payment", () => {
  it("a cash payment (no reference) retried: one payment, paid / balance / receivables / customer balance once", async () => {
    const { orderId, customerId } = await order();
    const k = key();
    const first = await pay(orderId, { amount: 40000, method: "cash" }, k);
    const after1 = money(orderId, customerId);
    expect(after1).toEqual({ order: { amountPaid: 40000, balance: 60000, paymentStatus: "partial", paymentCount: 1 }, customerOwes: 60000, receivables: 60000, payments: 1 });
    // The response was lost; the browser sends the same request again.
    const again = await pay(orderId, { amount: 40000, method: "cash" }, k);
    expect(again).toMatchObject({ paymentId: first.paymentId, alreadyRecorded: true });
    expect(money(orderId, customerId)).toEqual(after1);
    expect(first.paymentId).toBe(paymentIdForKey(k));
    // A different request (new key) is a second, real payment.
    await pay(orderId, { amount: 10000, method: "cash" }, key());
    expect(money(orderId, customerId)).toMatchObject({ order: { amountPaid: 50000, balance: 50000, paymentCount: 2 }, customerOwes: 50000, receivables: 50000, payments: 2 });
  });
  it("double tap: two identical requests at once → one payment", async () => {
    const { orderId, customerId } = await order();
    const k = key();
    const results = await Promise.allSettled([pay(orderId, { amount: 25000, method: "cash" }, k), pay(orderId, { amount: 25000, method: "cash" }, k)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(new Set(results.map((r) => r.value.paymentId)).size).toBe(1);
    expect(money(orderId, customerId)).toEqual({ order: { amountPaid: 25000, balance: 75000, paymentStatus: "partial", paymentCount: 1 }, customerOwes: 75000, receivables: 75000, payments: 1 });
    expect(docAt(`businesses/biz-a/usage/2026-10`)?.paymentsRecorded ?? 1).toBe(1);
  });
  it("a retry with a screenshot uploads it once; the same key for a different payment is refused, nothing changes", async () => {
    const { orderId, customerId } = await order();
    const k = key();
    const proof = { contentType: "image/png", dataBase64: PNG.toString("base64") };
    await pay(orderId, { amount: 30000, method: "gcash", reference: "1234567890123" }, k, { proof });
    const files = [...world.bucket.files?.keys?.() ?? []].length;
    const r = await pay(orderId, { amount: 30000, method: "gcash", reference: "1234567890123" }, k, { proof });
    expect(r.alreadyRecorded).toBe(true);
    expect([...world.bucket.files?.keys?.() ?? []].length).toBe(files);
    const before = money(orderId, customerId);
    await expect(pay(orderId, { amount: 99000, method: "cash" }, k)).rejects.toMatchObject({ code: "idempotency-conflict" });
    expect(money(orderId, customerId)).toEqual(before);
  });
  it("through the API: the key is required, a retry returns the same payment; another business can't reuse it", async () => {
    const { orderId, customerId } = await order();
    const call = async (body, businessId = "biz-a", uid = world.uids.ownera) => {
      const res = await createPaymentsHandler({ getAdmin: async () => world, now: () => NOW })({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    };
    const body = { action: "record", orderId, payment: { amount: 20000, method: "cash" } };
    expect((await call(body)).status).toBe(400);
    const k = key();
    const a = await call({ ...body, idempotencyKey: k });
    const b = await call({ ...body, idempotencyKey: k });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.paymentId).toBe(a.body.paymentId);
    expect(money(orderId, customerId).order).toMatchObject({ amountPaid: 20000, paymentCount: 1 });
    // biz-b with the same key: its own request space; biz-a's order isn't reachable.
    expect((await call({ ...body, idempotencyKey: k }, "biz-b", world.uids.ownerb)).status).toBe(404);
    expect(keys("businesses/biz-b/payments/")).toEqual([]);
  });
});

describe("Stock: the same Receive / Starting stock / Adjust / Count request twice moves stock once", () => {
  const product = async () => (await createProduct({ db: world.db, tenant: A, FieldValue, actor, input: { sku: `STK-${++n}`, name: "Tocino", unit: "pcs", sellingPrice: 12000, reorderLevel: 0 } })).productId;
  const move = (productId, movement, idempotencyKey) => recordMovement({ db: world.db, tenant: A, FieldValue, productId, movement, actor, idempotencyKey });
  const stock = (productId) => {
    const p = docAt(`businesses/biz-a/products/${productId}`);
    const c = docAt(`businesses/biz-a/productCosts/${productId}`);
    return { onHand: p.onHand, available: p.available, movements: p.movementCount, avg: c?.avgCostUnits ?? null, history: keys("businesses/biz-a/inventoryTransactions/").filter((k) => docAt(k).productId === productId).length };
  };
  it("starting stock, then Receive, each retried: stock, average cost and history change once", async () => {
    const p = await product();
    const k1 = key();
    const a = await move(p, { type: "opening", quantity: Q(20), unitCost: 6000, reason: "opening_balance" }, k1);
    const afterOpening = stock(p);
    expect(afterOpening).toMatchObject({ onHand: Q(20), available: Q(20), movements: 1, history: 1 });
    const a2 = await move(p, { type: "opening", quantity: Q(20), unitCost: 6000, reason: "opening_balance" }, k1);
    expect(a2).toMatchObject({ replayed: true, transactionId: a.transactionId, next: { onHand: Q(20) } });
    expect(stock(p)).toEqual(afterOpening);
    const k2 = key();
    await move(p, { type: "receipt", quantity: Q(10), unitCost: 9000, reason: "receipt" }, k2);
    const afterReceive = stock(p);
    expect(afterReceive).toMatchObject({ onHand: Q(30), movements: 2, history: 2 });
    for (let i = 0; i < 3; i++) await move(p, { type: "receipt", quantity: Q(10), unitCost: 9000, reason: "receipt" }, k2);
    expect(stock(p)).toEqual(afterReceive);
  });
  it("adjustment and count retried; two identical requests at once; same key for a different change is refused", async () => {
    const p = await product();
    await move(p, { type: "opening", quantity: Q(50), unitCost: 5000, reason: "opening_balance" }, key());
    const k = key();
    await move(p, { type: "adjustment_decrease", quantity: Q(3), reason: "damaged", note: null }, k);
    await move(p, { type: "adjustment_decrease", quantity: Q(3), reason: "damaged", note: null }, k);
    expect(stock(p)).toMatchObject({ onHand: Q(47), movements: 2 });
    const kc = key();
    const both = await Promise.allSettled([move(p, { type: "count", onHand: Q(40), reason: "count_correction", note: null }, kc), move(p, { type: "count", onHand: Q(40), reason: "count_correction", note: null }, kc)]);
    expect(both.every((r) => r.status === "fulfilled")).toBe(true);
    expect(stock(p)).toMatchObject({ onHand: Q(40), movements: 3 });
    const before = stock(p);
    await expect(move(p, { type: "adjustment_decrease", quantity: Q(9), reason: "damaged", note: null }, kc)).rejects.toMatchObject({ code: "idempotency-conflict" });
    await expect(move(p, { type: "receipt", quantity: Q(1), unitCost: 100, reason: "receipt" }, k)).rejects.toMatchObject({ code: "idempotency-conflict" });
    expect(stock(p)).toEqual(before);
  });
  it("through the API every stock action needs a key; a retried request answers with the stock now", async () => {
    const { createInventoryHandler } = await import("../../netlify/functions/inventory.js");
    const p = await product();
    const call = async (body) => {
      const res = await createInventoryHandler({ getAdmin: async () => world })({ ...request({ uid: world.uids.ownera, businessId: "biz-a", method: "POST" }), body: JSON.stringify(body) });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    };
    for (const action of ["receipt", "opening", "count", "adjustment_increase", "adjustment_decrease"]) expect((await call({ action, productId: p, quantity: Q(1), onHand: Q(1), unitCost: 100, reason: "count_correction" })).status, action).toBe(400);
    const k = key();
    const body = { action: "opening", idempotencyKey: k, productId: p, quantity: Q(12), unitCost: 4000 };
    const r1 = await call(body);
    const r2 = await call(body);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(r2.body.transactionId).toBe(r1.body.transactionId);
    expect(r2.body.balance.onHand).toBe(Q(12));
    expect(stock(p)).toMatchObject({ onHand: Q(12), movements: 1 });
  });
});
