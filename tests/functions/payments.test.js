// Phase 8 server: payments service + POST /api/payments + the orders
// "stage" action. Payment state is derived from records; Sales/COGS stay
// with fulfillment; duplicates are per business; proofs are server-only.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { recordPayment, updatePayment, verifyPayment, voidPayment, readProof, decodeProof } from "../../netlify/functions/_lib/payments.js";
import { createOrder, fulfillOrder, cancelOrder, updateOrder, setFulfillmentStage } from "../../netlify/functions/_lib/orders.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createPaymentsHandler } from "../../netlify/functions/payments.js";
import { createOrdersHandler } from "../../netlify/functions/orders.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { financialSummary } from "../../shared/finance.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-carlo", name: "Carlo", email: "c@t.test" };
const BIZ = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" };
const NOW = new Date("2026-10-08T05:22:00Z"); // 13:22 Manila
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
let world;
let A;
let k = 0;

beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});

const docAt = (p) => world.db.docs.get(p);
const order = (id) => docAt(`businesses/biz-a/orders/${id}`);
const fin = (id) => financialSummary(docAt(`businesses/biz-a/financialMetrics/${id}`));

async function orderOf(totalPesos = 10000, { fulfill = false } = {}) {
  const { productId } = await createProduct({ db: world.db, tenant: A, FieldValue, actor, input: { sku: `P-${++k}`, name: "Item", unit: "pcs", sellingPrice: totalPesos * 100, reorderLevel: 0 } });
  await recordMovement({ db: world.db, tenant: A, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(10), unitCost: totalPesos * 50, note: "count" } });
  const { orderId } = await createOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, entitlements: docAt("businesses/biz-a").entitlements, input: { customer: { name: "ABC Store" }, source: "viber", items: [{ productId, quantity: Q(1) }] }, idempotencyKey: `pay-key-${String(++k).padStart(10, "0")}`, actor, canDiscount: false, now: NOW });
  if (fulfill) await fulfillOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId, actor, now: NOW });
  return { orderId, productId };
}
const pay = (orderId, payment, { canVerify = true, proof = null, tenant = A, business = BIZ } = {}) =>
  recordPayment({ db: world.db, bucket: world.bucket, tenant, FieldValue, business, orderId, input: payment, proof, actor, canVerify, now: NOW });

describe("THE scenario: ₱10,000 order, ₱4,000 then ₱6,000", () => {
  it("partial then paid; Sales/COGS untouched by payments", async () => {
    const { orderId } = await orderOf(10000);
    await pay(orderId, { amount: 400000, method: "gcash", reference: "1111 2222" });
    expect(order(orderId)).toMatchObject({ amountPaid: 400000, balance: 600000, paymentStatus: "partial", paymentCount: 1 });
    await pay(orderId, { amount: 600000, method: "bank_transfer", reference: "BT-998877" });
    expect(order(orderId)).toMatchObject({ amountPaid: 1000000, balance: 0, paymentStatus: "paid", paymentCount: 2, lastPaymentRef: "BT998877" });
    const today = fin("2026-10-08");
    expect(today.paymentsReceived).toBe(1000000);
    expect(today.grossSales).toBe(0); // not fulfilled: no sales
    expect(today.cogs).toBe(0);
    expect(docAt("businesses/biz-a/metrics/current").unpaidOrders).toBe(0);
    expect(docAt("businesses/biz-a/financialMetrics/current").receivablesOutstanding).toBe(0);
  });

  it("payment before fulfillment, then fulfillment: payments and sales stay separate", async () => {
    const { orderId } = await orderOf(750);
    await pay(orderId, { amount: 75000, method: "cash" });
    expect(fin("2026-10-08")).toMatchObject({ paymentsReceived: 75000, grossSales: 0, cogs: 0 });
    await fulfillOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId, actor, now: NOW });
    expect(fin("2026-10-08")).toMatchObject({ paymentsReceived: 75000, grossSales: 75000, cogs: 37500 });
    expect(order(orderId)).toMatchObject({ paymentStatus: "paid", fulfillmentStatus: "fulfilled" });
  });
});

describe("rules of a payment", () => {
  it("no overpayment", async () => {
    const { orderId } = await orderOf(1000);
    await expect(pay(orderId, { amount: 100001, method: "cash" })).rejects.toMatchObject({ code: "overpayment" });
    await pay(orderId, { amount: 60000, method: "cash" });
    await expect(pay(orderId, { amount: 40001, method: "cash" })).rejects.toMatchObject({ code: "overpayment" });
    expect(order(orderId).amountPaid).toBe(60000);
  });

  it("GCash / Maya / bank need a reference; cash and COD don't", async () => {
    const { orderId } = await orderOf(1000);
    await expect(pay(orderId, { amount: 100, method: "gcash" })).rejects.toMatchObject({ code: "reference-required" });
    await expect(pay(orderId, { amount: 100, method: "cash" })).resolves.toBeTruthy();
    await expect(pay(orderId, { amount: 100, method: "cod" })).resolves.toBeTruthy();
  });

  it.each([["zero", 0], ["negative", -5], ["fractional", 10.5], ["string", "100"], ["NaN", NaN]])("rejects a %s amount", async (_l, amount) => {
    const { orderId } = await orderOf(1000);
    await expect(pay(orderId, { amount, method: "cash" })).rejects.toBeTruthy();
  });

  it("refuses forged fields and cancelled orders", async () => {
    const { orderId } = await orderOf(1000);
    await expect(pay(orderId, { amount: 100, method: "cash", verified: true })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(pay(orderId, { amount: 100, method: "cash", amountPaid: 100000 })).rejects.toMatchObject({ code: "invalid-input" });
    const other = await orderOf(1000);
    await cancelOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId: other.orderId, reason: "changed mind", actor, now: NOW });
    await expect(pay(other.orderId, { amount: 100, method: "cash" })).rejects.toMatchObject({ code: "order-cancelled" });
  });

  it("an order with payments can't be cancelled until they're removed", async () => {
    const { orderId } = await orderOf(1000);
    const { paymentId } = await pay(orderId, { amount: 100, method: "cash" });
    await expect(cancelOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId, reason: "nope", actor, now: NOW })).rejects.toMatchObject({ code: "has-payments" });
    await voidPayment({ db: world.db, tenant: A, FieldValue, business: BIZ, paymentId, reason: "entered on wrong order", actor });
    await expect(cancelOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId, reason: "nope", actor, now: NOW })).resolves.toBeTruthy();
  });
});

describe("THE duplicate-reference scenario", () => {
  it("ABC123 accepted once in A, refused again in A, allowed in B", async () => {
    const one = await orderOf(1000);
    const two = await orderOf(1000);
    await pay(one.orderId, { amount: 100, method: "gcash", reference: "ABC123" });
    await expect(pay(two.orderId, { amount: 100, method: "gcash", reference: "abc-123" })).rejects.toMatchObject({ code: "duplicate-reference", message: "This payment reference has already been used." });
    // Business B
    const B = tenantDb(world.db, "biz-b");
    const { productId } = await createProduct({ db: world.db, tenant: B, FieldValue, actor, input: { sku: "B-1", name: "B", unit: "pcs", sellingPrice: 1000, reorderLevel: 0 } });
    await recordMovement({ db: world.db, tenant: B, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(5), unitCost: 500, note: "x" } });
    const bo = await createOrder({ db: world.db, tenant: B, FieldValue, business: { ...BIZ, id: "biz-b" }, entitlements: docAt("businesses/biz-b").entitlements, input: { customer: { name: "B" }, source: "phone", items: [{ productId, quantity: Q(1) }] }, idempotencyKey: "b-pay-key-00000000001", actor, canDiscount: false, now: NOW });
    await expect(pay(bo.orderId, { amount: 100, method: "gcash", reference: "ABC123" }, { tenant: B, business: { ...BIZ, id: "biz-b" } })).resolves.toMatchObject({ state: "verified" });
  });

  it("removing a payment frees its reference; editing moves it", async () => {
    const { orderId } = await orderOf(1000);
    const p = await pay(orderId, { amount: 100, method: "gcash", reference: "REF0001" });
    await updatePayment({ db: world.db, bucket: world.bucket, tenant: A, FieldValue, business: BIZ, paymentId: p.paymentId, changes: { reference: "REF0002" }, actor });
    await expect(pay(orderId, { amount: 100, method: "gcash", reference: "REF0001" })).resolves.toBeTruthy();
    await expect(pay(orderId, { amount: 100, method: "gcash", reference: "REF0002" })).rejects.toMatchObject({ code: "duplicate-reference" });
    await voidPayment({ db: world.db, tenant: A, FieldValue, business: BIZ, paymentId: p.paymentId, reason: "wrong order", actor });
    await expect(pay(orderId, { amount: 100, method: "gcash", reference: "REF0002" })).resolves.toBeTruthy();
  });
});

describe("verification, edits and removal keep everything consistent", () => {
  it("staff record -> for verification; owner verifies -> paid", async () => {
    const { orderId } = await orderOf(1000);
    const p = await pay(orderId, { amount: 100000, method: "gcash", reference: "918273645" }, { canVerify: false });
    expect(p.state).toBe("for_verification");
    expect(order(orderId)).toMatchObject({ paymentStatus: "for_verification", amountPaid: 100000, pendingPaid: 100000, balance: 0 });
    await verifyPayment({ db: world.db, tenant: A, FieldValue, paymentId: p.paymentId, actor });
    expect(order(orderId)).toMatchObject({ paymentStatus: "paid", verifiedPaid: 100000, pendingPaid: 0 });
    expect(docAt(`businesses/biz-a/payments/${p.paymentId}`).history.map((h) => h.type)).toEqual(["recorded", "verified"]);
  });

  it("Edit -> Save: reference and amount corrections update the order, metrics and history", async () => {
    const { orderId } = await orderOf(3000);
    const p = await pay(orderId, { amount: 245000, method: "gcash", reference: "91827364" });
    await updatePayment({ db: world.db, bucket: world.bucket, tenant: A, FieldValue, business: BIZ, paymentId: p.paymentId, changes: { reference: "918273645", amount: 240000 }, actor });
    const payment = docAt(`businesses/biz-a/payments/${p.paymentId}`);
    expect(payment).toMatchObject({ amount: 240000, reference: "918273645" });
    expect(payment.history.slice(1).map((h) => h.label)).toEqual(["Payment amount changed ₱2,450.00 → ₱2,400.00", "Reference changed 91827364 → 918273645"]);
    expect(order(orderId)).toMatchObject({ amountPaid: 240000, balance: 60000, paymentStatus: "partial", lastPaymentRef: "918273645" });
    expect(fin("2026-10-08").paymentsReceived).toBe(240000);
    expect(docAt("businesses/biz-a/financialMetrics/current").receivablesOutstanding).toBe(60000);
    await expect(updatePayment({ db: world.db, bucket: world.bucket, tenant: A, FieldValue, business: BIZ, paymentId: p.paymentId, changes: { amount: 300001 }, actor })).rejects.toMatchObject({ code: "overpayment" });
  });

  it("removing a payment keeps the record, needs a reason, and restores the balance", async () => {
    const { orderId } = await orderOf(1000);
    const p = await pay(orderId, { amount: 100000, method: "cash" });
    expect(docAt("businesses/biz-a/metrics/current").unpaidOrders).toBe(0);
    await expect(voidPayment({ db: world.db, tenant: A, FieldValue, business: BIZ, paymentId: p.paymentId, reason: "", actor })).rejects.toMatchObject({ code: "reason-required" });
    await voidPayment({ db: world.db, tenant: A, FieldValue, business: BIZ, paymentId: p.paymentId, reason: "Recorded on the wrong order", actor });
    expect(docAt(`businesses/biz-a/payments/${p.paymentId}`)).toMatchObject({ state: "voided", voidReason: "Recorded on the wrong order", amount: 100000 });
    expect(order(orderId)).toMatchObject({ amountPaid: 0, balance: 100000, paymentStatus: "unpaid", paymentCount: 0 });
    expect(fin("2026-10-08").paymentsReceived).toBe(0);
    expect(docAt("businesses/biz-a/metrics/current").unpaidOrders).toBe(1);
    await expect(updatePayment({ db: world.db, bucket: world.bucket, tenant: A, FieldValue, business: BIZ, paymentId: p.paymentId, changes: { amount: 1 }, actor })).rejects.toMatchObject({ code: "voided" });
  });

  it("order corrections can't drop the total below what's been paid", async () => {
    const { orderId, productId } = await orderOf(1000, { fulfill: true });
    await pay(orderId, { amount: 100000, method: "cash" });
    await expect(updateOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId, input: { customer: { name: "ABC Store" }, source: "viber", items: [{ productId, quantity: Q(1) }], discount: 50000 }, actor, canDiscount: true, canCorrect: true, reason: "late discount" })).rejects.toMatchObject({ code: "below-paid" });
    expect(order(orderId).amountPaid).toBe(100000);
  });
});

describe("payment screenshots (server-only storage)", () => {
  it("stores under the tenant prefix with no public token, and reads back only within the tenant", async () => {
    const { orderId } = await orderOf(1000);
    const p = await pay(orderId, { amount: 100, method: "gcash", reference: "PROOF001" }, { proof: { contentType: "image/png", dataBase64: PNG.toString("base64") } });
    const payment = docAt(`businesses/biz-a/payments/${p.paymentId}`);
    expect(payment.proof.path).toMatch(new RegExp(`^tenants/biz-a/payments/proofs/${orderId}/${p.paymentId}-[a-f0-9]{8}\\.png$`));
    const stored = world.storage.files.get(payment.proof.path);
    expect(stored.metadata).not.toHaveProperty("firebaseStorageDownloadTokens");
    expect(order(orderId).lastProofPaymentId).toBe(p.paymentId);
    const back = await readProof({ tenant: A, bucket: world.bucket, businessId: "biz-a", paymentId: p.paymentId });
    expect(Buffer.from(back.dataBase64, "base64").equals(PNG)).toBe(true);
    // B's tenant can't resolve A's payment id
    await expect(readProof({ tenant: tenantDb(world.db, "biz-b"), bucket: world.bucket, businessId: "biz-b", paymentId: p.paymentId })).rejects.toMatchObject({ code: "not-found" });
  });

  it("a payment record pointing at another business's file is refused before any download", async () => {
    const { orderId } = await orderOf(1000);
    const a = await pay(orderId, { amount: 100, method: "gcash", reference: "PROOF002" }, { proof: { contentType: "image/png", dataBase64: PNG.toString("base64") } });
    const aPath = docAt(`businesses/biz-a/payments/${a.paymentId}`).proof.path;
    // A tampered/misfiled record in B that names A's object.
    await world.db.doc("businesses/biz-b/payments/payTAMPERED00000001").set({ orderId, amount: 100, state: "verified", proof: { path: aPath, contentType: "image/png" } });
    const download = vi.spyOn(await world.bucket(), "file");
    await expect(readProof({ tenant: tenantDb(world.db, "biz-b"), bucket: world.bucket, businessId: "biz-b", paymentId: "payTAMPERED00000001" })).rejects.toMatchObject({ code: "not-found" });
    expect(download).not.toHaveBeenCalled();
    download.mockRestore();
  });

  it("checks the real file type and size", () => {
    expect(decodeProof({ contentType: "image/jpeg", dataBase64: JPEG.toString("base64") }).contentType).toBe("image/jpeg");
    expect(() => decodeProof({ contentType: "image/png", dataBase64: Buffer.from("<script>alert(1)</script>").toString("base64") })).toThrow(/JPEG, PNG or WebP/);
    expect(() => decodeProof({ contentType: "image/png", dataBase64: JPEG.toString("base64") })).toThrow(/isn't the type it claims/);
    expect(() => decodeProof({ contentType: "image/png", dataBase64: Buffer.concat([PNG, Buffer.alloc(2_600_000)]).toString("base64") })).toThrow(/under/);
    expect(() => decodeProof({ contentType: "image/png", dataBase64: "not base64!!" })).toThrow();
  });

  it("a failed payment doesn't leave its screenshot behind", async () => {
    const { orderId } = await orderOf(1000);
    await expect(pay(orderId, { amount: 999999999, method: "cash" }, { proof: { contentType: "image/png", dataBase64: PNG.toString("base64") } })).rejects.toBeTruthy();
    expect(world.storage.files.size).toBe(0);
  });
});

describe("fulfillment stage dropdown", () => {
  it("moves freely between open stages, logs it, and never fulfils or cancels", async () => {
    const { orderId } = await orderOf(1000);
    await setFulfillmentStage({ db: world.db, tenant: A, FieldValue, orderId, stage: "preparing", actor });
    await setFulfillmentStage({ db: world.db, tenant: A, FieldValue, orderId, stage: "ready", actor });
    await setFulfillmentStage({ db: world.db, tenant: A, FieldValue, orderId, stage: "preparing", actor }); // mistake fixed
    expect(order(orderId).fulfillmentStatus).toBe("preparing");
    expect(order(orderId).statusHistory.filter((h) => h.type === "stage").map((h) => `${h.from}->${h.to}`)).toEqual(["pending->preparing", "preparing->ready", "ready->preparing"]);
    await expect(setFulfillmentStage({ db: world.db, tenant: A, FieldValue, orderId, stage: "fulfilled", actor })).rejects.toMatchObject({ code: "invalid-stage" });
    await expect(setFulfillmentStage({ db: world.db, tenant: A, FieldValue, orderId, stage: "cancelled", actor })).rejects.toMatchObject({ code: "invalid-stage" });
    await fulfillOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId, actor, now: NOW }); // from "preparing"
    expect(order(orderId).fulfillmentStatus).toBe("fulfilled");
    await expect(setFulfillmentStage({ db: world.db, tenant: A, FieldValue, orderId, stage: "ready", actor })).rejects.toMatchObject({ code: "not-pending" });
  });
});

describe("POST /api/payments", () => {
  const handler = () => createPaymentsHandler({ getAdmin: async () => world, now: () => NOW });
  const call = async (uid, body, businessId) => {
    const res = await handler()({ ...request({ uid, businessId, method: "POST" }), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  it("401 first", async () => {
    expect((await handler()({ ...request({ method: "POST" }), body: "{x" })).statusCode).toBe(401);
  });

  it("staff record (for verification) but can't verify, edit or remove; owner can", async () => {
    const { orderId } = await orderOf(1000);
    const rec = await call(world.uids.staffa, { action: "record", orderId, payment: { amount: 50000, method: "gcash", reference: "STAFF001" } });
    expect(rec).toMatchObject({ status: 201, body: { state: "for_verification", paymentStatus: "for_verification" } });
    const id = rec.body.paymentId;
    expect((await call(world.uids.staffa, { action: "verify", paymentId: id })).status).toBe(403);
    expect((await call(world.uids.staffa, { action: "update", paymentId: id, changes: { amount: 1 } })).status).toBe(403);
    expect((await call(world.uids.staffa, { action: "void", paymentId: id, reason: "no no" })).status).toBe(403);
    expect((await call(world.uids.ownera, { action: "verify", paymentId: id })).body.paymentStatus).toBe("partial");
    const own = await call(world.uids.ownera, { action: "record", orderId, payment: { amount: 50000, method: "cash" } });
    expect(own.body).toMatchObject({ state: "verified", paymentStatus: "paid" });
  });

  it("view-only (payments.view without payments.record) can open screenshots but not record", async () => {
    const { orderId } = await orderOf(1000);
    const p = await pay(orderId, { amount: 100, method: "gcash", reference: "VIEWONLY1" }, { proof: { contentType: "image/png", dataBase64: PNG.toString("base64") } });
    world.db.docs.get(`businesses/biz-a/members/${world.uids.staffa}`).permissions["payments.record"] = false;
    expect((await call(world.uids.staffa, { action: "record", orderId, payment: { amount: 100, method: "cash" } })).status).toBe(403);
    expect((await call(world.uids.staffa, { action: "proof", paymentId: p.paymentId })).status).toBe(200);
  });

  it("strict payloads and friendly duplicate message", async () => {
    const { orderId } = await orderOf(1000);
    expect((await call(world.uids.ownera, { action: "record", orderId, payment: { amount: 100, method: "cash" }, amountPaid: 1 })).status).toBe(400);
    await call(world.uids.ownera, { action: "record", orderId, payment: { amount: 100, method: "maya", reference: "DUP-0001" } });
    const dup = await call(world.uids.ownera, { action: "record", orderId, payment: { amount: 100, method: "maya", reference: "dup 0001" } });
    expect(dup).toMatchObject({ status: 409, body: { error: "duplicate-reference", message: "This payment reference has already been used." } });
  });

  it("Payments module off -> refused; suspended -> read-only", async () => {
    const { orderId } = await orderOf(1000);
    world.db.docs.get("businesses/biz-a").entitlements.modules.payments = false;
    expect((await call(world.uids.ownera, { action: "record", orderId, payment: { amount: 100, method: "cash" } })).status).toBe(403);
    expect((await call(world.uids.owners, { action: "record", orderId, payment: { amount: 100, method: "cash" } })).body.error).toBe("read-only");
  });

  it("cross-tenant: A can't record on, read, or touch B's payments and proofs", async () => {
    const B = tenantDb(world.db, "biz-b");
    const { productId } = await createProduct({ db: world.db, tenant: B, FieldValue, actor, input: { sku: "B-9", name: "B", unit: "pcs", sellingPrice: 1000, reorderLevel: 0 } });
    await recordMovement({ db: world.db, tenant: B, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(5), unitCost: 500, note: "x" } });
    const bo = await createOrder({ db: world.db, tenant: B, FieldValue, business: { ...BIZ, id: "biz-b" }, entitlements: docAt("businesses/biz-b").entitlements, input: { customer: { name: "B" }, source: "phone", items: [{ productId, quantity: Q(1) }] }, idempotencyKey: "b-pay-key-00000000002", actor, canDiscount: false, now: NOW });
    const bp = await pay(bo.orderId, { amount: 100, method: "gcash", reference: "BPROOF01" }, { tenant: B, business: { ...BIZ, id: "biz-b" }, proof: { contentType: "image/png", dataBase64: PNG.toString("base64") } });
    for (const uid of [world.uids.ownera, world.uids.managera, world.uids.staffa]) {
      expect((await call(uid, { action: "proof", paymentId: bp.paymentId }, "biz-b")).body.error).toBe("business-access-denied");
      expect((await call(uid, { action: "proof", paymentId: bp.paymentId })).status).toBe(404);
      expect((await call(uid, { action: "record", orderId: bo.orderId, payment: { amount: 100, method: "cash" } })).status).toBe(404);
    }
    expect((await call(world.uids.ownera, { action: "void", paymentId: bp.paymentId, reason: "hijack" })).status).toBe(404);
    expect(docAt(`businesses/biz-b/payments/${bp.paymentId}`).state).toBe("verified");
  });

  it("orders 'stage' action needs orders.fulfill and the open-stage rule", async () => {
    const { orderId } = await orderOf(1000);
    const orders = createOrdersHandler({ getAdmin: async () => world, now: () => NOW });
    const res = await orders({ ...request({ uid: world.uids.staffa, method: "POST" }), body: JSON.stringify({ action: "stage", orderId, stage: "ready" }) });
    expect(res.statusCode).toBe(200);
    const bad = await orders({ ...request({ uid: world.uids.staffa, method: "POST" }), body: JSON.stringify({ action: "stage", orderId, stage: "fulfilled" }) });
    expect(JSON.parse(bad.body).error).toBe("invalid-stage");
  });
});
