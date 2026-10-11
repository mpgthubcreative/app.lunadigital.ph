// Phase 7.1: correcting FULFILLED orders through the normal update path,
// and deleting accidental open orders. History is appended, never
// rewritten; returned units come back at their ORIGINAL cost snapshot.

import { describe, it, expect, beforeEach } from "vitest";
import { createOrder, updateOrder, fulfillOrder, deleteOrder } from "../../netlify/functions/_lib/orders.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createOrdersHandler } from "../../netlify/functions/orders.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { financialSummary } from "../../shared/finance.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-carlo", name: "Carlo", email: "carlo@t.test" };
const BIZ = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" };
const NOW = new Date("2026-10-08T02:00:00Z"); // 10:00 Manila
let world;
let A;
let k = 0;

beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});

const docAt = (p) => world.db.docs.get(p);
const docsUnder = (prefix) => [...world.db.docs.entries()].filter(([p]) => p.startsWith(prefix)).map(([p, d]) => ({ id: p.split("/").at(-1), ...d }));
const product = (pid) => docAt(`businesses/biz-a/products/${pid}`);
const fin = (id) => financialSummary(docAt(`businesses/biz-a/financialMetrics/${id}`));

async function stocked({ qty = 100, cost = 5000, price = 7500, sku = "WINGS" } = {}) {
  const { productId } = await createProduct({ db: world.db, tenant: A, FieldValue, actor, input: { sku, name: "Chicken Wings", unit: "pcs", sellingPrice: price, reorderLevel: 0 } });
  await recordMovement({ db: world.db, tenant: A, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(qty), unitCost: cost, note: "count" } });
  return productId;
}
const input = (items, extra = {}) => ({ customer: { name: "Juan" }, source: "messenger", items, ...extra });
const create = (items, extra = {}) => createOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, entitlements: docAt("businesses/biz-a").entitlements, input: input(items, extra), idempotencyKey: `corr-key-${String(++k).padStart(8, "0")}`, actor, canDiscount: true, now: NOW });
const fulfill = (orderId, now = NOW) => fulfillOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId, actor, now });
const correct = (orderId, items, { reason = "Encoded the wrong quantity", canCorrect = true, extra = {}, revision = null } = {}) =>
  updateOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId, input: input(items, extra), expectedRevision: revision, actor, canDiscount: true, canCorrect, reason });

async function fulfilledTen() {
  const pid = await stocked();
  const { orderId } = await create([{ productId: pid, quantity: Q(10) }]);
  await fulfill(orderId);
  return { pid, orderId };
}

describe("THE correction: fulfilled 10 -> 8", () => {
  it("restores +2 stock, Sales ₱750 → ₱600, COGS ₱500 → ₱400 on the fulfilment day, history appended", async () => {
    const { pid, orderId } = await fulfilledTen();
    expect(product(pid).onHand).toBe(Q(90));
    const result = await correct(orderId, [{ productId: pid, quantity: Q(8) }], { reason: "Customer ordered 8" });
    expect(result).toMatchObject({ corrected: true, delta: { grossSales: -15000, discounts: 0, cogs: -10000 } });

    expect(product(pid)).toMatchObject({ onHand: Q(92), reserved: 0, available: Q(92) });
    expect(fin("2026-10-08")).toMatchObject({ grossSales: 60000, netSales: 60000, cogs: 40000, grossProfit: 20000 });
    expect(fin("2026-10")).toMatchObject({ netSales: 60000, cogs: 40000 });

    const order = docAt(`businesses/biz-a/orders/${orderId}`);
    expect(order).toMatchObject({ fulfillmentStatus: "fulfilled", subtotal: 60000, total: 60000, balance: 60000 });
    const entry = order.statusHistory.at(-1);
    expect(entry).toMatchObject({ type: "corrected", actor, reason: "Customer ordered 8", changes: { lines: [{ from: Q(10), to: Q(8), inventory: Q(2) }], sales: { from: 75000, to: 60000 } } });
    expect(entry.at).toBeInstanceOf(Date);
    expect(JSON.stringify(entry)).not.toMatch(/cogs|cost/i); // order history is visible to staff
    expect(order.statusHistory.map((h) => h.type)).toEqual(["created", "fulfilled", "corrected"]);

    const costs = docAt(`businesses/biz-a/orderCosts/${orderId}`);
    expect(costs).toMatchObject({ cogs: 40000, grossProfit: 20000, lines: [expect.objectContaining({ quantity: Q(8), costConsumed: 40000 })] });
    expect(costs.corrections).toEqual([expect.objectContaining({ actor, reason: "Customer ordered 8", before: expect.objectContaining({ cogs: 50000, netSales: 75000 }), after: expect.objectContaining({ cogs: 40000, netSales: 60000 }) })]);

    // The original fulfilment movement is untouched; the correction is a new one.
    const moves = docsUnder("businesses/biz-a/inventoryTransactions/").filter((t) => t.referenceId === orderId).sort((a, b) => a.seq - b.seq);
    expect(moves.map((m) => [m.type, m.onHandDelta])).toEqual([["reservation", 0], ["fulfillment", -Q(10)], ["correction_in", Q(2)]]);
    expect(docAt("businesses/biz-a/financialMetrics/current").receivablesOutstanding).toBe(60000);
  });

  it("uses the ORIGINAL cost basis even after the product's average cost changed", async () => {
    const { pid, orderId } = await fulfilledTen();
    // New stock at ₱70 moves the average from ₱50 to ₱60 (90 @ 50 + 90 @ 70).
    await recordMovement({ db: world.db, tenant: A, FieldValue, productId: pid, actor, movement: { type: "receipt", quantity: Q(90), unitCost: 7000 } });
    expect(docAt(`businesses/biz-a/productCosts/${pid}`).avgCostUnits).toBe(60000000);
    await correct(orderId, [{ productId: pid, quantity: Q(8) }]);
    // COGS falls by 2 x ₱50 (the snapshot), not 2 x ₱60 (today's average).
    expect(fin("2026-10-08").cogs).toBe(40000);
    expect(docAt(`businesses/biz-a/orderCosts/${orderId}`).cogs).toBe(40000);
    // The 2 units re-enter stock at ₱50: (180 @ 60 + 2 @ 50) / 182
    const costTx = docsUnder("businesses/biz-a/inventoryTransactionCosts/").find((c) => c.type === "correction_in");
    expect(costTx).toMatchObject({ avgCostBefore: 60000000, valueAfter: costTx.valueBefore + 10000 });
  });

  it("an increase consumes the extra units at today's average", async () => {
    const { pid, orderId } = await fulfilledTen();
    await recordMovement({ db: world.db, tenant: A, FieldValue, productId: pid, actor, movement: { type: "receipt", quantity: Q(90), unitCost: 7000 } }); // avg ₱60
    await correct(orderId, [{ productId: pid, quantity: Q(12) }]);
    expect(product(pid).onHand).toBe(Q(178));
    expect(docAt(`businesses/biz-a/orderCosts/${orderId}`).cogs).toBe(50000 + 12000); // 10 @ 50 kept + 2 @ 60
    expect(fin("2026-10-08")).toMatchObject({ grossSales: 90000, cogs: 62000 });
  });

  it("removing a product line returns all of it at its snapshot; adding one consumes at today's cost", async () => {
    const a = await stocked({ sku: "A-1", cost: 5000 });
    const b = await stocked({ sku: "B-1", cost: 2000, price: 3000 });
    const { orderId } = await create([{ productId: a, quantity: Q(4) }]);
    await fulfill(orderId);
    await correct(orderId, [{ productId: b, quantity: Q(3) }], { reason: "Wrong product encoded" });
    expect(product(a).onHand).toBe(Q(100));
    expect(product(b).onHand).toBe(Q(97));
    expect(docAt(`businesses/biz-a/orderCosts/${orderId}`)).toMatchObject({ cogs: 6000, grossSales: 9000 });
    expect(fin("2026-10-08")).toMatchObject({ grossSales: 9000, cogs: 6000, grossProfit: 3000 });
  });

  it("corrections post to the original fulfilment day, whenever they happen", async () => {
    const { pid, orderId } = await fulfilledTen();
    // corrected later: still adjusts 2026-10-08, the day the sale was recognized
    await correct(orderId, [{ productId: pid, quantity: Q(9) }]);
    expect(fin("2026-10-08").grossSales).toBe(67500);
    expect(docsUnder("businesses/biz-a/financialMetrics/").map((d) => d.id).sort()).toEqual(["2026-10", "2026-10-08", "current"]);
  });
});

describe("reasons and permissions", () => {
  it("a reason is required only for material changes", async () => {
    const { pid, orderId } = await fulfilledTen();
    await expect(correct(orderId, [{ productId: pid, quantity: Q(8) }], { reason: "" })).rejects.toMatchObject({ code: "reason-required" });
    await expect(correct(orderId, [{ productId: pid, quantity: Q(10) }], { reason: "", extra: { notes: "Delivered to back door" } })).resolves.toMatchObject({ corrected: true });
    expect(docAt(`businesses/biz-a/orders/${orderId}`).notes).toBe("Delivered to back door");
    expect(docAt(`businesses/biz-a/orderCosts/${orderId}`).corrections).toBeUndefined();
  });

  it("without orders.correct, a fulfilled order can't be edited at all", async () => {
    const { pid, orderId } = await fulfilledTen();
    await expect(correct(orderId, [{ productId: pid, quantity: Q(8) }], { canCorrect: false })).rejects.toMatchObject({ code: "not-pending" });
    expect(product(pid).onHand).toBe(Q(90));
  });

  it("cancelled orders stay uneditable", async () => {
    const pid = await stocked();
    const { orderId } = await create([{ productId: pid, quantity: Q(1) }]);
    world.db.docs.get(`businesses/biz-a/orders/${orderId}`).fulfillmentStatus = "cancelled";
    await expect(correct(orderId, [{ productId: pid, quantity: Q(2) }])).rejects.toMatchObject({ code: "not-pending" });
  });

  it("a correction can't drop below what's been paid (Phase 8 ready)", async () => {
    const { pid, orderId } = await fulfilledTen();
    world.db.docs.get(`businesses/biz-a/orders/${orderId}`).amountPaid = 70000;
    await expect(correct(orderId, [{ productId: pid, quantity: Q(8) }])).rejects.toMatchObject({ code: "below-paid" });
  });
});

describe("deleting accidental open orders", () => {
  it("releases reservations, keeps an audit snapshot, leaves no sales, keeps plan usage", async () => {
    const pid = await stocked();
    const { orderId, orderNumber } = await create([{ productId: pid, quantity: Q(5) }]);
    expect(product(pid).reserved).toBe(Q(5));
    await deleteOrder({ db: world.db, tenant: A, FieldValue, orderId, reason: "Duplicate entry", actor });
    expect(docAt(`businesses/biz-a/orders/${orderId}`)).toBeUndefined();
    expect(product(pid)).toMatchObject({ onHand: Q(100), reserved: 0, available: Q(100) });
    const audit = docsUnder("businesses/biz-a/auditLog/").find((a) => a.type === "order.deleted");
    expect(audit).toMatchObject({ orderId, orderNumber, actor, reason: "Duplicate entry", snapshot: expect.objectContaining({ total: 37500 }) });
    expect(docAt("businesses/biz-a/financialMetrics/2026-10-08")).toBeUndefined();
    expect(docAt("businesses/biz-a/metrics/2026-10-08").orderCount).toBe(0);
    expect(docAt("businesses/biz-a/metrics/current")).toMatchObject({ pendingFulfillment: 0, unpaidOrders: 0 });
    expect(docAt("businesses/biz-a/usage/2026-10").ordersCreated).toBe(1);
    // The release is in inventory history, referencing the deleted order.
    expect(docsUnder("businesses/biz-a/inventoryTransactions/").some((t) => t.referenceId === orderId && t.type === "release")).toBe(true);
  });

  it("fulfilled or paid orders can't be deleted", async () => {
    const { orderId } = await fulfilledTen();
    await expect(deleteOrder({ db: world.db, tenant: A, FieldValue, orderId, actor })).rejects.toMatchObject({ code: "not-deletable" });
    const pid = await stocked({ sku: "P-2" });
    const paid = await create([{ productId: pid, quantity: Q(1) }]);
    world.db.docs.get(`businesses/biz-a/orders/${paid.orderId}`).amountPaid = 100;
    await expect(deleteOrder({ db: world.db, tenant: A, FieldValue, orderId: paid.orderId, actor })).rejects.toMatchObject({ code: "not-deletable" });
  });
});

describe("POST /api/orders: corrections and deletes", () => {
  const handler = () => createOrdersHandler({ getAdmin: async () => world, now: () => NOW });
  const call = async (uid, body, businessId) => {
    const res = await handler()({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  it("owner corrects with the plain update action; staff are refused; staff can't delete", async () => {
    const { pid, orderId } = await fulfilledTen();
    const update = (reason) => ({ action: "update", orderId, order: input([{ productId: pid, quantity: Q(8) }]), ...(reason ? { reason } : {}) });
    const staff = await call(world.uids.staffa, update("trying"));
    expect(staff).toMatchObject({ status: 409, body: { error: "not-pending" } });
    expect((await call(world.uids.managera, update())).body.error).toBe("reason-required");
    const owner = await call(world.uids.ownera, update("Encoded 10, actually 8"));
    expect(owner.status).toBe(200);
    expect(owner.body.correction).toEqual({ grossSales: -15000, discounts: 0, cogs: -10000 }); // financial user
    const pending = await create([{ productId: pid, quantity: Q(1) }]);
    expect((await call(world.uids.staffa, { action: "delete", orderId: pending.orderId })).status).toBe(403);
    expect((await call(world.uids.ownera, { action: "delete", orderId: pending.orderId })).body).toMatchObject({ deleted: true });
  });

  it("Business A can't correct or delete Business B's orders", async () => {
    const B = tenantDb(world.db, "biz-b");
    const { productId: bp } = await createProduct({ db: world.db, tenant: B, FieldValue, actor, input: { sku: "B-1", name: "B", unit: "pcs", sellingPrice: 100, reorderLevel: 0 } });
    await recordMovement({ db: world.db, tenant: B, FieldValue, productId: bp, actor, movement: { type: "opening", quantity: Q(10), unitCost: 50, note: "x" } });
    const bOrder = await createOrder({ db: world.db, tenant: B, FieldValue, business: { ...BIZ, id: "biz-b" }, entitlements: docAt("businesses/biz-b").entitlements, input: input([{ productId: bp, quantity: Q(2) }]), idempotencyKey: "b-key-000000000000001", actor, canDiscount: false, now: NOW });
    await fulfillOrder({ db: world.db, tenant: B, FieldValue, business: BIZ, orderId: bOrder.orderId, actor, now: NOW });
    const body = { action: "update", orderId: bOrder.orderId, order: input([{ productId: bp, quantity: Q(1) }]), reason: "hijack attempt" };
    expect((await call(world.uids.ownera, body, "biz-b")).body.error).toBe("business-access-denied");
    expect((await call(world.uids.ownera, body)).status).toBe(404);
    expect((await call(world.uids.ownera, { action: "delete", orderId: bOrder.orderId })).status).toBe(404);
    expect(docAt(`businesses/biz-b/orders/${bOrder.orderId}`).items[0].quantity).toBe(Q(2));
    expect(docAt(`businesses/biz-b/products/${bp}`).onHand).toBe(Q(8));
  });
});

describe("delivery address on a fulfilled order (Phase 18.6)", () => {
  it("correcting only the address needs no reason, saves it and notes it in the history", async () => {
    const { pid, orderId } = await fulfilledTen();
    await correct(orderId, [{ productId: pid, quantity: Q(10) }], { reason: "", extra: { deliveryAddress: "7 Luna St, Pasig" } });
    const o = docAt(`businesses/biz-a/orders/${orderId}`);
    expect(o.deliveryAddress).toBe("7 Luna St, Pasig");
    expect(o.statusHistory.at(-1)).toMatchObject({ type: "corrected", changes: expect.objectContaining({ deliveryAddress: true }) });
  });
});
