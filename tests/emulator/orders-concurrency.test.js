// Order concurrency on the REAL Firestore emulator through the Admin SDK:
// racing reservations, all-or-nothing multi-item orders, cancel vs fulfill,
// edit vs fulfill, duplicate submissions, order-number uniqueness and the
// monthly limit. Every outcome must be explicit (success, a domain refusal,
// or contention) and the stored state must match exactly what succeeded.

import { beforeAll, describe, it, expect, vi } from "vitest";
import { QTY_SCALE } from "../../shared/quantity.js";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "conc-orders", name: "Concurrency", email: "" };
const BUSINESS = { timezone: "Asia/Manila", orderPrefix: "CC" };
const NOW = new Date("2026-10-08T02:00:00Z");
let db;
let FieldValue;
let inv;
let orders;
let tenantDb;
let run = 0;
let keySeq = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the Firestore emulator).");
  const admin = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin: { firestore: { FieldValue } } } = await admin.getAdmin());
  inv = await import("../../netlify/functions/_lib/inventory.js");
  orders = await import("../../netlify/functions/_lib/orders.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
});

const CONTENDED = 10;
const settle = (p) => Promise.allSettled(p);
const ok = (r) => r.filter((x) => x.status === "fulfilled");
function expectExplicit(results, codes = []) {
  for (const r of results) if (r.status === "rejected") expect([CONTENDED, ...codes], String(r.reason && r.reason.message)).toContain(r.reason && r.reason.code);
}
const key = () => `conc-key-${Date.now().toString(36)}-${++keySeq}`.padEnd(20, "x");

function freshTenant() {
  run += 1;
  return tenantDb(db, `ordc-${Date.now().toString(36)}-${run}`);
}

async function stocked(tenant, { qty = 100, cost = 5000, price = 7500, sku } = {}) {
  run += 1;
  const { productId } = await inv.createProduct({ db, tenant, FieldValue, actor, input: { sku: sku || `S-${run}`, name: `Item ${run}`, unit: "pcs", sellingPrice: price, reorderLevel: 0 } });
  if (qty > 0) await inv.recordMovement({ db, tenant, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(qty), unitCost: cost, note: "count" } });
  return productId;
}

const create = (tenant, items, { limit = 1000, idem = key(), customer = "Racer" } = {}) =>
  orders.createOrder({ db, tenant, FieldValue, business: BUSINESS, entitlements: { limits: { ordersPerMonth: limit } }, input: { customer: { name: customer }, source: "phone", items }, idempotencyKey: idem, actor, canDiscount: false, now: NOW });

const product = async (tenant, pid) => (await tenant.doc("products", pid).get()).data();

describe("inventory contention", () => {
  it("two orders race for the last 5 units: only what's available is reserved", async () => {
    const t = freshTenant();
    const pid = await stocked(t, { qty: 5 });
    const results = await settle([create(t, [{ productId: pid, quantity: Q(5) }]), create(t, [{ productId: pid, quantity: Q(5) }])]);
    expectExplicit(results, ["insufficient-stock"]);
    expect(ok(results)).toHaveLength(1);
    expect(await product(t, pid)).toMatchObject({ onHand: Q(5), reserved: Q(5), available: 0 });
  });

  it("10 one-unit orders against 5 available: reserved equals the orders that succeeded, never more", async () => {
    const t = freshTenant();
    const pid = await stocked(t, { qty: 5 });
    const results = await settle(Array.from({ length: 10 }, () => create(t, [{ productId: pid, quantity: Q(1) }])));
    expectExplicit(results, ["insufficient-stock"]);
    const p = await product(t, pid);
    expect(ok(results).length).toBeLessThanOrEqual(5);
    expect(p.reserved).toBe(Q(ok(results).length));
    expect((await t.collection("orders").get()).size).toBe(ok(results).length);
  });

  it("3-product order with one product short: nothing stays reserved, no order exists", async () => {
    const t = freshTenant();
    const [a, b, c] = [await stocked(t, { qty: 10 }), await stocked(t, { qty: 10 }), await stocked(t, { qty: 1 })];
    await expect(create(t, [{ productId: a, quantity: Q(2) }, { productId: b, quantity: Q(2) }, { productId: c, quantity: Q(3) }])).rejects.toMatchObject({ code: "insufficient-stock" });
    for (const pid of [a, b, c]) expect((await product(t, pid)).reserved).toBe(0);
    expect((await t.collection("orders").get()).size).toBe(0);
  });
});

describe("terminal-state races", () => {
  it("cancel vs fulfill at the same time: exactly one wins, never both", async () => {
    const t = freshTenant();
    const pid = await stocked(t, { qty: 10 });
    const { orderId } = await create(t, [{ productId: pid, quantity: Q(4) }]);
    const results = await settle([
      orders.fulfillOrder({ db, tenant: t, FieldValue, business: BUSINESS, orderId, actor, now: NOW }),
      orders.cancelOrder({ db, tenant: t, FieldValue, business: BUSINESS, orderId, reason: "race test", actor, now: NOW }),
    ]);
    expectExplicit(results, ["not-pending"]);
    expect(ok(results)).toHaveLength(1);
    const order = (await t.doc("orders", orderId).get()).data();
    const p = await product(t, pid);
    expect(p.reserved).toBe(0);
    if (order.fulfillmentStatus === "fulfilled") {
      expect(p.onHand).toBe(Q(6));
      expect((await t.doc("orderCosts", orderId).get()).exists).toBe(true);
    } else {
      expect(order.fulfillmentStatus).toBe("cancelled");
      expect(p.onHand).toBe(Q(10));
      expect((await t.doc("orderCosts", orderId).get()).exists).toBe(false);
    }
    expect(order.statusHistory.filter((h) => h.type === "fulfilled" || h.type === "cancelled")).toHaveLength(1);
  });

  it("edit vs fulfill: the final state matches whichever order of events happened", async () => {
    const t = freshTenant();
    const pid = await stocked(t, { qty: 20 });
    const { orderId } = await create(t, [{ productId: pid, quantity: Q(5) }]);
    const results = await settle([
      orders.updateOrder({ db, tenant: t, FieldValue, orderId, input: { customer: { name: "Racer" }, source: "phone", items: [{ productId: pid, quantity: Q(8) }] }, actor, canDiscount: false }),
      orders.fulfillOrder({ db, tenant: t, FieldValue, business: BUSINESS, orderId, actor, now: NOW }),
    ]);
    expectExplicit(results, ["not-pending"]);
    const order = (await t.doc("orders", orderId).get()).data();
    const p = await product(t, pid);
    const costs = (await t.doc("orderCosts", orderId).get()).data();
    const fulfilledQty = order.items[0].quantity;
    // Whatever won, fulfillment consumed exactly the order's final quantity
    // and nothing remains reserved.
    expect(order.fulfillmentStatus).toBe(results[1].status === "fulfilled" ? "fulfilled" : "pending");
    if (order.fulfillmentStatus === "fulfilled") {
      expect(p).toMatchObject({ onHand: Q(20) - fulfilledQty, reserved: 0 });
      expect(costs.lines[0].quantity).toBe(fulfilledQty);
    }
    expect([Q(5), Q(8)]).toContain(fulfilledQty);
  });
});

describe("submission and numbering races", () => {
  it("8 simultaneous submissions with the same idempotency key: one order, reserved once", async () => {
    const t = freshTenant();
    const pid = await stocked(t, { qty: 50 });
    const idem = key();
    const results = await settle(Array.from({ length: 8 }, () => create(t, [{ productId: pid, quantity: Q(3) }], { idem })));
    expectExplicit(results);
    const ids = new Set(ok(results).map((r) => r.value.orderId));
    expect(ids.size).toBe(1);
    expect((await t.collection("orders").get()).size).toBe(1);
    expect((await product(t, pid)).reserved).toBe(Q(3));
    expect((await t.doc("usage", "2026-10").get()).data().ordersCreated).toBe(1);
  });

  it("15 simultaneous creates: every successful order has a unique number, in sequence", async () => {
    const t = freshTenant();
    const pid = await stocked(t, { qty: 100 });
    const results = await settle(Array.from({ length: 15 }, (_, i) => create(t, [{ productId: pid, quantity: Q(1) }], { customer: `C${i}` })));
    expectExplicit(results);
    const numbers = ok(results).map((r) => r.value.orderNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
    const seqs = numbers.map((n) => Number(n.split("-").at(-1))).sort((a, b) => a - b);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // no gaps, no duplicates
    expect((await product(t, pid)).reserved).toBe(Q(numbers.length));
  });

  it("monthly limit race: with one order left, simultaneous creates never exceed the limit", async () => {
    const t = freshTenant();
    const pid = await stocked(t, { qty: 100 });
    await create(t, [{ productId: pid, quantity: Q(1) }], { limit: 3 });
    await create(t, [{ productId: pid, quantity: Q(1) }], { limit: 3 });
    const results = await settle(Array.from({ length: 8 }, () => create(t, [{ productId: pid, quantity: Q(1) }], { limit: 3 })));
    expectExplicit(results, ["order-limit-reached"]);
    expect(ok(results).length).toBeLessThanOrEqual(1);
    const usage = (await t.doc("usage", "2026-10").get()).data().ordersCreated;
    expect(usage).toBeLessThanOrEqual(3);
    expect(usage).toBe(2 + ok(results).length);
    expect((await t.collection("orders").get()).size).toBe(usage);
  });
});

describe("Phase 7.1 correction races", () => {
  const correct = (t, orderId, pid, qty, reason = "concurrency correction") =>
    orders.updateOrder({ db, tenant: t, FieldValue, business: BUSINESS, orderId, input: { customer: { name: "Racer" }, source: "phone", items: [{ productId: pid, quantity: Q(qty) }] }, actor, canDiscount: false, canCorrect: true, reason });

  async function fulfilledOrder(t, pid, qty) {
    const { orderId } = await create(t, [{ productId: pid, quantity: Q(qty) }]);
    await orders.fulfillOrder({ db, tenant: t, FieldValue, business: BUSINESS, orderId, actor, now: NOW });
    return orderId;
  }

  async function consistent(t, pid, orderId, startStock) {
    const order = (await t.doc("orders", orderId).get()).data();
    const costs = (await t.doc("orderCosts", orderId).get()).data();
    const fin = (await t.doc("financialMetrics", "2026-10-08").get()).data();
    const p = await product(t, pid);
    const q = order.items[0].quantity;
    // Stock, order, cost record and the day's metrics all agree on the final quantity.
    expect(p.onHand).toBe(Q(startStock) - q);
    expect(costs.lines[0].quantity).toBe(q);
    expect(costs.cogs).toBe((q / QTY_SCALE) * 5000);
    expect(fin.cogs).toBe(costs.cogs);
    expect(fin.grossSales).toBe(order.subtotal);
    return q;
  }

  it("two identical simultaneous corrections 10 -> 8 restore +2 exactly once", async () => {
    const t = freshTenant();
    const pid = await stocked(t, { qty: 100, cost: 5000 });
    const orderId = await fulfilledOrder(t, pid, 10);
    const results = await settle([correct(t, orderId, pid, 8), correct(t, orderId, pid, 8)]);
    expectExplicit(results);
    expect(ok(results).length).toBeGreaterThan(0);
    expect(await consistent(t, pid, orderId, 100)).toBe(Q(8));
    expect((await product(t, pid)).onHand).toBe(Q(92));
  });

  it("10 -> 8 racing 10 -> 12: whichever lands last wins, nothing double-adjusts", async () => {
    const t = freshTenant();
    const pid = await stocked(t, { qty: 100, cost: 5000 });
    const orderId = await fulfilledOrder(t, pid, 10);
    const results = await settle([correct(t, orderId, pid, 8), correct(t, orderId, pid, 12)]);
    expectExplicit(results);
    const q = await consistent(t, pid, orderId, 100);
    expect([Q(8), Q(12)]).toContain(q);
    const corrections = (await t.doc("orderCosts", orderId).get()).data().corrections;
    expect(corrections.length).toBe(ok(results).length);
  });

  it("deleting an open order while it's being fulfilled: one outcome only", async () => {
    const t = freshTenant();
    const pid = await stocked(t, { qty: 10 });
    const { orderId } = await create(t, [{ productId: pid, quantity: Q(3) }]);
    const results = await settle([
      orders.deleteOrder({ db, tenant: t, FieldValue, orderId, actor }),
      orders.fulfillOrder({ db, tenant: t, FieldValue, business: BUSINESS, orderId, actor, now: NOW }),
    ]);
    expectExplicit(results, ["not-deletable", "not-found", "not-pending"]);
    expect(ok(results)).toHaveLength(1);
    const p = await product(t, pid);
    expect(p.reserved).toBe(0);
    const exists = (await t.doc("orders", orderId).get()).exists;
    expect(p.onHand).toBe(exists ? Q(7) : Q(10));
  });
});
