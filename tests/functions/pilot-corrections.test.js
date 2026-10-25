// Distributor pilot readiness (2026-10-25): corrections and reversals
// written against the CURRENT code before changing anything. Every effect
// (stock, order total, paid, balance, the customer's balance, receivables,
// sales / COGS) must move exactly once, and a repeated action must change
// nothing.

import { describe, it, expect, beforeEach } from "vitest";
import { recordPayment, verifyPayment, voidPayment } from "../../netlify/functions/_lib/payments.js";
import { createOrder, fulfillOrder, cancelOrder, updateOrder } from "../../netlify/functions/_lib/orders.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createCustomer } from "../../netlify/functions/_lib/customers.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld } from "../helpers/tenants.js";
import { financialSummary } from "../../shared/finance.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-owner", name: "Owner", email: "o@t.test" };
const BIZ = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" };
const NOW = new Date("2026-10-25T05:00:00Z");
const DAY = "2026-10-25";
let world;
let A;
let n = 0;
beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});
const docAt = (p) => world.db.docs.get(p);
const c = { get db() { return world.db; }, get tenant() { return A; }, FieldValue, actor };
const key = () => `corr-key-${String(++n).padStart(10, "0")}`;

// ₱100 each (cost ₱50), 10 in stock; a saved customer orders `qty`.
async function setup(qty = 2) {
  const { productId } = await createProduct({ ...c, input: { sku: `C-${++n}`, name: "Siomai", unit: "pcs", sellingPrice: 10000, reorderLevel: 0 } });
  await recordMovement({ ...c, productId, movement: { type: "opening", quantity: Q(10), unitCost: 5000, note: "count" } });
  const { customerId } = await createCustomer({ ...c, input: { name: "ABC Restaurant" } });
  const { orderId } = await createOrder({ ...c, business: BIZ, entitlements: docAt("businesses/biz-a").entitlements, input: { customerId, customer: { name: "ABC Restaurant" }, source: "viber", items: [{ productId, quantity: Q(qty) }] }, idempotencyKey: key(), canDiscount: false, canLinkCustomers: true, now: NOW });
  currentCustomer = customerId;
  return { productId, customerId, orderId };
}
const snap = ({ productId, customerId, orderId }) => {
  const o = docAt(`businesses/biz-a/orders/${orderId}`);
  const p = docAt(`businesses/biz-a/products/${productId}`);
  const f = financialSummary(docAt(`businesses/biz-a/financialMetrics/${DAY}`));
  return {
    stock: { onHand: p.onHand, reserved: p.reserved, available: p.available },
    order: { total: o.total, amountPaid: o.amountPaid ?? 0, balance: o.balance, paymentStatus: o.paymentStatus, fulfillmentStatus: o.fulfillmentStatus },
    customerOwes: docAt(`businesses/biz-a/customers/${customerId}`).stats.outstandingBalance,
    receivables: docAt("businesses/biz-a/financialMetrics/current").receivablesOutstanding,
    sales: { grossSales: f.grossSales, discounts: f.discounts, cogs: f.cogs },
    movements: [...world.db.docs.keys()].filter((k) => k.startsWith("businesses/biz-a/inventoryTransactions/") && docAt(k).productId === productId).length,
  };
};
const pay = (orderId, amount, canVerify = true) => recordPayment({ ...c, bucket: world.bucket, business: BIZ, orderId, input: { amount, method: "cash" }, canVerify, now: NOW, idempotencyKey: key() });
// A correction as the order editor sends it: the same customer (customerId kept).
let currentCustomer = null;
const items = (productId, qty) => ({ customerId: currentCustomer, customer: { name: "ABC Restaurant" }, source: "viber", items: [{ productId, quantity: Q(qty) }] });

describe("correcting a FULFILLED order", () => {
  it("quantity up / down after fulfilment: stock, total, paid, balance, receivables, customer balance, sales and COGS once", async () => {
    const ids = await setup(2);
    await pay(ids.orderId, 10000);
    await fulfillOrder({ ...c, business: BIZ, orderId: ids.orderId, now: NOW });
    expect(snap(ids)).toEqual({ stock: { onHand: Q(8), reserved: 0, available: Q(8) }, order: { total: 20000, amountPaid: 10000, balance: 10000, paymentStatus: "partial", fulfillmentStatus: "fulfilled" }, customerOwes: 10000, receivables: 10000, sales: { grossSales: 20000, discounts: 0, cogs: 10000 }, movements: 3 });
    const order = docAt(`businesses/biz-a/orders/${ids.orderId}`);
    // 2 → 3 (one more delivered).
    await updateOrder({ ...c, business: BIZ, orderId: ids.orderId, input: items(ids.productId, 3), expectedRevision: order.revision, canDiscount: false, canLinkCustomers: true, canCorrect: true, reason: "Delivered one more pack" });
    const up = snap(ids);
    expect(up).toEqual({ stock: { onHand: Q(7), reserved: 0, available: Q(7) }, order: { total: 30000, amountPaid: 10000, balance: 20000, paymentStatus: "partial", fulfillmentStatus: "fulfilled" }, customerOwes: 20000, receivables: 20000, sales: { grossSales: 30000, discounts: 0, cogs: 15000 }, movements: 4 });
    // The same correction sent again with the old revision: refused, nothing moves.
    await expect(updateOrder({ ...c, business: BIZ, orderId: ids.orderId, input: items(ids.productId, 3), expectedRevision: order.revision, canDiscount: false, canLinkCustomers: true, canCorrect: true, reason: "Delivered one more pack" })).rejects.toMatchObject({ code: "stale-order" });
    expect(snap(ids)).toEqual(up);
    // The same quantity again (current revision): no change at all.
    const now2 = docAt(`businesses/biz-a/orders/${ids.orderId}`);
    await updateOrder({ ...c, business: BIZ, orderId: ids.orderId, input: items(ids.productId, 3), expectedRevision: now2.revision, canDiscount: false, canLinkCustomers: true, canCorrect: true, reason: "Same again" }).catch(() => null);
    expect(snap(ids)).toEqual(up);
    // 3 → 1 (two came back): stock back in at the original cost; balance 0.
    const now3 = docAt(`businesses/biz-a/orders/${ids.orderId}`);
    await updateOrder({ ...c, business: BIZ, orderId: ids.orderId, input: items(ids.productId, 1), expectedRevision: now3.revision, canDiscount: false, canLinkCustomers: true, canCorrect: true, reason: "Two packs returned" });
    expect(snap(ids)).toEqual({ stock: { onHand: Q(9), reserved: 0, available: Q(9) }, order: { total: 10000, amountPaid: 10000, balance: 0, paymentStatus: "paid", fulfillmentStatus: "fulfilled" }, customerOwes: 0, receivables: 0, sales: { grossSales: 10000, discounts: 0, cogs: 5000 }, movements: 5 });
    // Never below what's paid.
    const now4 = docAt(`businesses/biz-a/orders/${ids.orderId}`);
    await expect(updateOrder({ ...c, business: BIZ, orderId: ids.orderId, input: { ...items(ids.productId, 1), discount: 5000 }, expectedRevision: now4.revision, canDiscount: true, canLinkCustomers: true, canCorrect: true, reason: "Discount" })).rejects.toMatchObject({ code: "below-paid" });
  });
  it("a price correction (discount, by someone allowed) on a fulfilled unpaid order: total, balance, receivables, discounts once; COGS unchanged", async () => {
    const ids = await setup(2);
    await fulfillOrder({ ...c, business: BIZ, orderId: ids.orderId, now: NOW });
    const o = docAt(`businesses/biz-a/orders/${ids.orderId}`);
    await expect(updateOrder({ ...c, business: BIZ, orderId: ids.orderId, input: { ...items(ids.productId, 2), discount: 2000 }, expectedRevision: o.revision, canDiscount: false, canLinkCustomers: true, canCorrect: true, reason: "Agreed price" })).rejects.toMatchObject({ code: "discount-not-allowed" });
    await updateOrder({ ...c, business: BIZ, orderId: ids.orderId, input: { ...items(ids.productId, 2), discount: 2000 }, expectedRevision: o.revision, canDiscount: true, canLinkCustomers: true, canCorrect: true, reason: "Agreed price ₱90 each" });
    expect(snap(ids)).toMatchObject({ stock: { onHand: Q(8) }, order: { total: 18000, balance: 18000 }, customerOwes: 18000, receivables: 18000, sales: { grossSales: 20000, discounts: 2000, cogs: 10000 } });
    // Someone without orders.correct can't touch a fulfilled order.
    const o2 = docAt(`businesses/biz-a/orders/${ids.orderId}`);
    await expect(updateOrder({ ...c, business: BIZ, orderId: ids.orderId, input: items(ids.productId, 5), expectedRevision: o2.revision, canDiscount: false, canLinkCustomers: true, canCorrect: false })).rejects.toMatchObject({ code: "not-pending" });
  });
});

describe("a part-paid order: Payment → Verify → Void → Cancel", () => {
  it("the payment comes off once, the order is cancelled once, stock is released once, history is kept; repeats are refused", async () => {
    const ids = await setup(4); // ₱400
    const { paymentId } = await pay(ids.orderId, 15000, false); // for verification
    await verifyPayment({ ...c, paymentId });
    expect(snap(ids)).toMatchObject({ stock: { onHand: Q(10), reserved: Q(4), available: Q(6) }, order: { total: 40000, amountPaid: 15000, balance: 25000, paymentStatus: "partial" }, customerOwes: 25000, receivables: 25000 });
    // Cancel while a payment stands: refused (void it first).
    await expect(cancelOrder({ ...c, business: BIZ, orderId: ids.orderId, reason: "Customer changed mind", now: NOW })).rejects.toMatchObject({ code: "has-payments" });
    await voidPayment({ ...c, business: BIZ, paymentId, reason: "Refunded in cash" });
    const afterVoid = snap(ids);
    expect(afterVoid).toMatchObject({ order: { amountPaid: 0, balance: 40000, paymentStatus: "unpaid" }, customerOwes: 40000, receivables: 40000 });
    await expect(voidPayment({ ...c, business: BIZ, paymentId, reason: "Again" })).rejects.toMatchObject({ code: "voided" });
    expect(snap(ids)).toEqual(afterVoid);
    await cancelOrder({ ...c, business: BIZ, orderId: ids.orderId, reason: "Customer changed mind", now: NOW });
    const afterCancel = snap(ids);
    expect(afterCancel).toMatchObject({ stock: { onHand: Q(10), reserved: 0, available: Q(10) }, order: { balance: 0, fulfillmentStatus: "cancelled" }, customerOwes: 0, receivables: 0, sales: { grossSales: 0, cogs: 0 } });
    await expect(cancelOrder({ ...c, business: BIZ, orderId: ids.orderId, reason: "Again", now: NOW })).rejects.toMatchObject({ code: "not-pending" });
    expect(snap(ids)).toEqual(afterCancel);
    // History kept: the payment (recorded, verified, voided) and the order's steps.
    const p = docAt(`businesses/biz-a/payments/${paymentId}`);
    expect(p.state).toBe("voided");
    expect(p.history.map((h) => h.type)).toEqual(expect.arrayContaining(["recorded", "verified", "voided"]));
    const o = docAt(`businesses/biz-a/orders/${ids.orderId}`);
    expect(o.statusHistory.map((h) => h.type)).toEqual(expect.arrayContaining(["created", "payment", "cancelled"]));
    // A cancelled order takes no payment.
    await expect(pay(ids.orderId, 1000)).rejects.toMatchObject({ code: "order-cancelled" });
  });
});
