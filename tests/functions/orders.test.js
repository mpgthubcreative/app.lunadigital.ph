// Phase 7 server: the orders service (reservation, edit, fulfillment with
// COGS snapshot, cancellation, numbering, idempotency, plan limit, metrics)
// and POST /api/orders (auth, permissions, modules, subscription, forged
// fields, cross-tenant).

import { describe, it, expect, beforeEach } from "vitest";
import { createOrder, updateOrder, fulfillOrder, cancelOrder } from "../../netlify/functions/_lib/orders.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createOrdersHandler } from "../../netlify/functions/orders.js";
import { updateOverrides, ensureAuthUser, addMember } from "../../netlify/functions/_lib/provisioning.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { financialSummary } from "../../shared/finance.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-staff", name: "Staff A", email: "staff@t.test" };
const MANILA = { id: "biz-a", name: "Biz A", timezone: "Asia/Manila", currency: "PHP", orderPrefix: "BA" };
const NOW = new Date("2026-10-08T02:00:00Z"); // 10:00 Manila, 2026-10-08
let world;
let A;
let key = 0;
const nextKey = () => `idem-key-${String(++key).padStart(8, "0")}`;

beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});

const docAt = (path) => world.db.docs.get(path);
const docsUnder = (prefix) => [...world.db.docs.entries()].filter(([p]) => p.startsWith(prefix)).map(([p, d]) => ({ id: p.split("/").at(-1), ...d }));
const entitlements = () => docAt("businesses/biz-a").entitlements;
const product = (pid) => docAt(`businesses/biz-a/products/${pid}`);

async function stockedProduct({ sku = "P-1", name = "Product", price = 7500, cost = 5000, qty = 100, unit = "pcs" } = {}) {
  const { productId } = await createProduct({ db: world.db, tenant: A, FieldValue, actor, input: { sku, name, unit, sellingPrice: price, reorderLevel: 0 } });
  await recordMovement({ db: world.db, tenant: A, FieldValue, productId, actor, movement: { type: "opening", quantity: unit === "pcs" ? Q(qty) : qty, unitCost: cost, note: "count" } });
  return productId;
}

const create = (items, extra = {}) =>
  createOrder({
    db: world.db,
    tenant: A,
    FieldValue,
    business: MANILA,
    entitlements: entitlements(),
    input: { customer: { name: "Juan Dela Cruz", phone: "0917 123 4567" }, source: "messenger", items, ...extra.input },
    idempotencyKey: extra.key || nextKey(),
    actor,
    canDiscount: extra.canDiscount ?? false,
    now: extra.now || NOW,
  });
const fulfill = (orderId, now = NOW) => fulfillOrder({ db: world.db, tenant: A, FieldValue, business: MANILA, orderId, actor, now });
const cancel = (orderId, reason = "Customer changed mind", now = NOW) => cancelOrder({ db: world.db, tenant: A, FieldValue, business: MANILA, orderId, reason, actor, now });
const edit = (orderId, items, extra = {}) =>
  updateOrder({ db: world.db, tenant: A, FieldValue, orderId, input: { customer: { name: "Juan Dela Cruz" }, source: "messenger", items, ...extra.input }, expectedRevision: extra.revision ?? null, actor, canDiscount: extra.canDiscount ?? false });
const fin = (id) => financialSummary(docAt(`businesses/biz-a/financialMetrics/${id}`));

describe("THE sales-recognition scenario", () => {
  it("100 @ ₱50 avg, sell 10 @ ₱75: nothing recognized at creation; ₱750 sales / ₱500 COGS / ₱250 GP at fulfillment; COGS fixed after a later receipt", async () => {
    const pid = await stockedProduct({ price: 7500, cost: 5000, qty: 100 });
    const { orderId, orderNumber } = await create([{ productId: pid, quantity: Q(10) }]);

    // Immediately after creation
    expect(product(pid)).toMatchObject({ onHand: Q(100), reserved: Q(10), available: Q(90) });
    expect(docAt("businesses/biz-a/financialMetrics/2026-10-08")).toBeUndefined(); // Sales ₱0, COGS ₱0
    expect(docAt("businesses/biz-a/metrics/2026-10-08").orderCount).toBe(1);
    expect(docAt(`businesses/biz-a/orders/${orderId}`)).toMatchObject({ orderNumber, subtotal: 75000, total: 75000, amountPaid: 0, balance: 75000, paymentStatus: "unpaid", fulfillmentStatus: "pending" });

    // Fulfill
    const result = await fulfill(orderId);
    expect(product(pid)).toMatchObject({ onHand: Q(90), reserved: 0, available: Q(90) });
    expect(result).toMatchObject({ grossSales: 75000, cogs: 50000 });
    const today = fin("2026-10-08");
    expect(today).toMatchObject({ grossSales: 75000, netSales: 75000, cogs: 50000, grossProfit: 25000 });
    expect(fin("2026-10")).toMatchObject({ netSales: 75000, cogs: 50000, grossProfit: 25000 });
    expect(docAt(`businesses/biz-a/orderCosts/${orderId}`)).toMatchObject({ cogs: 50000, grossProfit: 25000, lines: [expect.objectContaining({ costConsumed: 50000 })] });

    // New stock at a different cost: the average moves, this order's COGS doesn't.
    await recordMovement({ db: world.db, tenant: A, FieldValue, productId: pid, actor, movement: { type: "receipt", quantity: Q(90), unitCost: 7000 } });
    expect(docAt(`businesses/biz-a/productCosts/${pid}`).avgCostUnits).toBe(60000000); // ₱60
    expect(docAt(`businesses/biz-a/orderCosts/${orderId}`).cogs).toBe(50000);
    expect(fin("2026-10-08").cogs).toBe(50000);
    // Fulfillment does not mean paid.
    expect(docAt(`businesses/biz-a/orders/${orderId}`).paymentStatus).toBe("unpaid");
  });
});

describe("THE cancellation scenario", () => {
  it("create 10, cancel: stock back to 100 / 0 / 100, no sales or COGS, order kept in history", async () => {
    const pid = await stockedProduct();
    const { orderId } = await create([{ productId: pid, quantity: Q(10) }]);
    await cancel(orderId, "Customer changed mind");
    expect(product(pid)).toMatchObject({ onHand: Q(100), reserved: 0, available: Q(100) });
    expect(docAt("businesses/biz-a/financialMetrics/2026-10-08")).toBeUndefined();
    const order = docAt(`businesses/biz-a/orders/${orderId}`);
    expect(order).toMatchObject({ fulfillmentStatus: "cancelled", cancellationReason: "Customer changed mind", balance: 0 });
    expect(order.statusHistory.map((h) => h.type)).toEqual(["created", "cancelled"]);
    expect(docAt("businesses/biz-a/metrics/2026-10-08")).toMatchObject({ orderCount: 1, cancelledOrders: 1 });
    expect(docAt("businesses/biz-a/metrics/current")).toMatchObject({ pendingFulfillment: 0, unpaidOrders: 0 });
    expect(docAt("businesses/biz-a/financialMetrics/current").receivablesOutstanding).toBe(0);
    // The created order still counts toward the month's plan usage.
    expect(docAt("businesses/biz-a/usage/2026-10").ordersCreated).toBe(1);
  });

  it("a fulfilled order can't be cancelled; a cancelled one can't be fulfilled", async () => {
    const pid = await stockedProduct();
    const a = await create([{ productId: pid, quantity: Q(1) }]);
    await fulfill(a.orderId);
    await expect(cancel(a.orderId)).rejects.toMatchObject({ code: "not-pending" });
    const b = await create([{ productId: pid, quantity: Q(1) }]);
    await cancel(b.orderId);
    await expect(fulfill(b.orderId)).rejects.toMatchObject({ code: "not-pending" });
    await expect(edit(b.orderId, [{ productId: pid, quantity: Q(2) }])).rejects.toMatchObject({ code: "not-pending" });
  });
});

describe("THE timezone scenario", () => {
  it("created 23:50 Manila on the 8th, fulfilled 00:10 on the 9th: count on the 8th, sales on the 9th", async () => {
    const pid = await stockedProduct();
    const created = new Date("2026-10-08T15:50:00Z"); // 23:50 Manila
    const fulfilled = new Date("2026-10-08T16:10:00Z"); // 00:10 Manila, the 9th (still the 8th in UTC)
    const { orderId, orderNumber } = await create([{ productId: pid, quantity: Q(2) }], { now: created });
    expect(orderNumber).toBe("BA-20261008-001");
    await fulfill(orderId, fulfilled);
    expect(docAt("businesses/biz-a/metrics/2026-10-08")).toMatchObject({ orderCount: 1 });
    expect(docAt("businesses/biz-a/metrics/2026-10-09")).toMatchObject({ fulfilledOrders: 1, orderCount: 0 });
    expect(fin("2026-10-09")).toMatchObject({ grossSales: 15000, cogs: 10000 });
    expect(docAt("businesses/biz-a/financialMetrics/2026-10-08")).toBeUndefined();
    expect(docAt(`businesses/biz-a/orders/${orderId}`)).toMatchObject({ orderDate: "2026-10-08", fulfilledDay: "2026-10-09" });
  });
});

describe("multi-item, all-or-nothing", () => {
  it("three products reserved together", async () => {
    const wings = await stockedProduct({ sku: "WINGS", name: "Chicken Wings", unit: "kg", qty: 50000, price: 30000 });
    const fries = await stockedProduct({ sku: "FRIES", name: "Fries", unit: "pcs", qty: 10, price: 90000 });
    const patty = await stockedProduct({ sku: "PATTY", name: "Burger Patties", unit: "pcs", qty: 10, price: 25000 });
    const { orderId } = await create([{ productId: wings, quantity: 5000 }, { productId: fries, quantity: Q(3) }, { productId: patty, quantity: Q(2) }]);
    const order = docAt(`businesses/biz-a/orders/${orderId}`);
    expect(order.items.map((l) => [l.sku, l.quantity, l.unitPrice, l.lineSubtotal])).toEqual([
      ["WINGS", 5000, 30000, 150000],
      ["FRIES", Q(3), 90000, 270000],
      ["PATTY", Q(2), 25000, 50000],
    ]);
    expect(order.subtotal).toBe(470000);
    expect(product(wings).reserved).toBe(5000);
  });

  it("one product short: nothing is reserved, nothing is created, no number consumed", async () => {
    const a = await stockedProduct({ sku: "A", qty: 10 });
    const b = await stockedProduct({ sku: "B", qty: 10 });
    const c = await stockedProduct({ sku: "C", qty: 1 });
    const before = structuredClone([...world.db.docs.entries()]);
    await expect(create([{ productId: a, quantity: Q(2) }, { productId: b, quantity: Q(2) }, { productId: c, quantity: Q(5) }])).rejects.toMatchObject({ code: "insufficient-stock" });
    expect([...world.db.docs.entries()]).toEqual(before);
  });
});

describe("prices, names and totals come from the server", () => {
  it("lines snapshot the product; later product edits don't rewrite the order", async () => {
    const pid = await stockedProduct({ price: 7500 });
    const { orderId } = await create([{ productId: pid, quantity: Q(2) }]);
    world.db.docs.get(`businesses/biz-a/products/${pid}`).sellingPrice = 9900;
    world.db.docs.get(`businesses/biz-a/products/${pid}`).name = "Renamed";
    const line = docAt(`businesses/biz-a/orders/${orderId}`).items[0];
    expect(line).toMatchObject({ name: "Product", unitPrice: 7500, lineSubtotal: 15000 });
  });

  it.each([
    ["forged unit price", { productId: "x", quantity: 1000, unitPrice: 1 }],
    ["forged name", { productId: "x", quantity: 1000, name: "Free" }],
    ["forged cost", { productId: "x", quantity: 1000, cost: 0 }],
  ])("rejects a %s on an item", async (_label, item) => {
    const pid = await stockedProduct();
    await expect(create([{ ...item, productId: pid }])).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("rejects forged totals / stock at the order level", async () => {
    const pid = await stockedProduct();
    for (const extra of [{ total: 1 }, { subtotal: 1 }, { amountPaid: 75000 }, { paymentStatus: "paid" }, { onHand: 1 }]) {
      await expect(create([{ productId: pid, quantity: Q(1) }], { input: extra })).rejects.toMatchObject({ code: "invalid-input" });
    }
  });

  it("decimal quantities follow the unit (kg) and refuse fractions of pcs", async () => {
    const kg = await stockedProduct({ sku: "KG", unit: "kg", qty: 10000, price: 12000 });
    const { orderId } = await create([{ productId: kg, quantity: 2500 }]);
    expect(docAt(`businesses/biz-a/orders/${orderId}`).total).toBe(30000); // 2.5 kg x ₱120
    const pcs = await stockedProduct({ sku: "PCS" });
    await expect(create([{ productId: pcs, quantity: 1500 }])).rejects.toMatchObject({ code: "invalid-quantity" });
  });
});

describe("discounts", () => {
  it("needs orders.discount; can't exceed the subtotal; flows into metrics", async () => {
    const pid = await stockedProduct({ price: 10000 });
    await expect(create([{ productId: pid, quantity: Q(1) }], { input: { discount: 1000 } })).rejects.toMatchObject({ code: "discount-not-allowed" });
    await expect(create([{ productId: pid, quantity: Q(1) }], { input: { discount: 20000 }, canDiscount: true })).rejects.toMatchObject({ code: "invalid-discount" });
    const { orderId } = await create([{ productId: pid, quantity: Q(1) }], { input: { discount: 1500 }, canDiscount: true });
    expect(docAt(`businesses/biz-a/orders/${orderId}`)).toMatchObject({ subtotal: 10000, discount: 1500, total: 8500, balance: 8500 });
    await fulfill(orderId);
    expect(fin("2026-10-08")).toMatchObject({ grossSales: 10000, discounts: 1500, netSales: 8500, cogs: 5000, grossProfit: 3500 });
  });
});

describe("delivery address (Phase 18.6)", () => {
  it("saved on create (blank = pick-up), changed on edit with a history note, kept on corrections", async () => {
    const pid = await stockedProduct({ price: 7500, qty: 100 });
    const pickup = await create([{ productId: pid, quantity: Q(1) }]);
    expect(docAt(`businesses/biz-a/orders/${pickup.orderId}`).deliveryAddress).toBeNull();
    const { orderId } = await create([{ productId: pid, quantity: Q(2) }], { input: { deliveryAddress: "12 Mabini St, QC" } });
    expect(docAt(`businesses/biz-a/orders/${orderId}`).deliveryAddress).toBe("12 Mabini St, QC");
    await edit(orderId, [{ productId: pid, quantity: Q(2) }], { input: { deliveryAddress: "45 Rizal Ave, Manila" } });
    const o = docAt(`businesses/biz-a/orders/${orderId}`);
    expect(o.deliveryAddress).toBe("45 Rizal Ave, Manila");
    expect(o.statusHistory.at(-1)).toMatchObject({ type: "edited", changes: expect.objectContaining({ deliveryAddress: true }) });
    await edit(orderId, [{ productId: pid, quantity: Q(3) }], { input: { deliveryAddress: "45 Rizal Ave, Manila" } });
    expect(docAt(`businesses/biz-a/orders/${orderId}`).statusHistory.at(-1).changes).not.toHaveProperty("deliveryAddress");
  });
});

describe("editing pending orders", () => {
  it("20 -> 15 releases 5; 15 -> 30 reserves 15 more; price snapshot kept; history records it", async () => {
    const pid = await stockedProduct({ price: 7500, qty: 100 });
    const { orderId } = await create([{ productId: pid, quantity: Q(20) }]);
    world.db.docs.get(`businesses/biz-a/products/${pid}`).sellingPrice = 9900; // today's price changed
    await edit(orderId, [{ productId: pid, quantity: Q(15) }]);
    expect(product(pid)).toMatchObject({ reserved: Q(15), available: Q(85) });
    await edit(orderId, [{ productId: pid, quantity: Q(30) }]);
    expect(product(pid)).toMatchObject({ reserved: Q(30), available: Q(70) });
    const order = docAt(`businesses/biz-a/orders/${orderId}`);
    expect(order.items[0]).toMatchObject({ unitPrice: 7500, quantity: Q(30), lineSubtotal: 225000 });
    expect(order.total).toBe(225000);
    expect(order.statusHistory.filter((h) => h.type === "edited").map((h) => h.changes.lines[0])).toEqual([
      expect.objectContaining({ from: Q(20), to: Q(15) }),
      expect.objectContaining({ from: Q(15), to: Q(30) }),
    ]);
    expect(docAt("businesses/biz-a/financialMetrics/current").receivablesOutstanding).toBe(225000);
  });

  it("an increase that can't be reserved fails and leaves the order unchanged", async () => {
    const pid = await stockedProduct({ qty: 25 });
    const { orderId } = await create([{ productId: pid, quantity: Q(20) }]);
    const before = structuredClone(docAt(`businesses/biz-a/orders/${orderId}`));
    await expect(edit(orderId, [{ productId: pid, quantity: Q(30) }])).rejects.toMatchObject({ code: "insufficient-stock" });
    expect(docAt(`businesses/biz-a/orders/${orderId}`)).toEqual(before);
    expect(product(pid).reserved).toBe(Q(20));
  });

  it("adding and removing products; new products use today's price", async () => {
    const a = await stockedProduct({ sku: "A", price: 1000 });
    const b = await stockedProduct({ sku: "B", price: 2000 });
    const { orderId } = await create([{ productId: a, quantity: Q(3) }]);
    await edit(orderId, [{ productId: b, quantity: Q(2) }]);
    expect(product(a).reserved).toBe(0);
    expect(product(b).reserved).toBe(Q(2));
    expect(docAt(`businesses/biz-a/orders/${orderId}`).items).toEqual([expect.objectContaining({ sku: "B", unitPrice: 2000, lineSubtotal: 4000 })]);
  });

  it("stale revision is refused", async () => {
    const pid = await stockedProduct();
    const { orderId } = await create([{ productId: pid, quantity: Q(1) }]);
    await edit(orderId, [{ productId: pid, quantity: Q(2) }], { revision: 1 });
    await expect(edit(orderId, [{ productId: pid, quantity: Q(3) }], { revision: 1 })).rejects.toMatchObject({ code: "stale-order" });
  });

  it("changing the discount needs orders.discount", async () => {
    const pid = await stockedProduct({ price: 10000 });
    const { orderId } = await create([{ productId: pid, quantity: Q(1) }]);
    await expect(edit(orderId, [{ productId: pid, quantity: Q(1) }], { input: { discount: 500 } })).rejects.toMatchObject({ code: "discount-not-allowed" });
  });
});

describe("numbering, idempotency, plan limit", () => {
  it("numbers are per business and per local day", async () => {
    const pid = await stockedProduct();
    const n1 = (await create([{ productId: pid, quantity: Q(1) }])).orderNumber;
    const n2 = (await create([{ productId: pid, quantity: Q(1) }])).orderNumber;
    const n3 = (await create([{ productId: pid, quantity: Q(1) }], { now: new Date("2026-10-08T16:30:00Z") })).orderNumber;
    expect([n1, n2, n3]).toEqual(["BA-20261008-001", "BA-20261008-002", "BA-20261009-001"]);
  });

  it("the default prefix is ORD, never another client's", async () => {
    const pid = await stockedProduct();
    const { orderNumber } = await createOrder({ db: world.db, tenant: A, FieldValue, business: { ...MANILA, orderPrefix: null }, entitlements: entitlements(), input: { customer: { name: "X" }, source: "phone", items: [{ productId: pid, quantity: Q(1) }] }, idempotencyKey: nextKey(), actor, canDiscount: false, now: NOW });
    expect(orderNumber).toMatch(/^ORD-20261008-\d{3}$/);
  });

  it("the same idempotency key creates ONE order and reserves once", async () => {
    const pid = await stockedProduct();
    const k = nextKey();
    const first = await create([{ productId: pid, quantity: Q(5) }], { key: k });
    const again = await create([{ productId: pid, quantity: Q(5) }], { key: k });
    expect(again).toMatchObject({ orderId: first.orderId, replayed: true });
    expect(docsUnder("businesses/biz-a/orders/")).toHaveLength(1);
    expect(product(pid).reserved).toBe(Q(5));
    expect(docAt("businesses/biz-a/usage/2026-10").ordersCreated).toBe(1);
    await expect(create([{ productId: pid, quantity: Q(6) }], { key: k })).rejects.toMatchObject({ code: "idempotency-conflict" });
  });

  it("enforces ordersPerMonth with overrides; cancelled orders still count", async () => {
    await updateOverrides({ ...world, businessId: "biz-a", set: { limits: { ordersPerMonth: 2 } }, actor: "t", reason: "tiny limit" });
    const pid = await stockedProduct();
    const a = await create([{ productId: pid, quantity: Q(1) }]);
    await cancel(a.orderId);
    await create([{ productId: pid, quantity: Q(1) }]);
    await expect(create([{ productId: pid, quantity: Q(1) }])).rejects.toMatchObject({ code: "order-limit-reached" });
    await updateOverrides({ ...world, businessId: "biz-a", set: { limits: { ordersPerMonth: 3 } }, actor: "t", reason: "raise" });
    await expect(create([{ productId: pid, quantity: Q(1) }])).resolves.toBeTruthy();
    // A new month starts fresh.
    await expect(create([{ productId: pid, quantity: Q(1) }], { now: new Date("2026-11-01T02:00:00Z") })).resolves.toBeTruthy();
  });

  it("validates customer, source and items", async () => {
    const pid = await stockedProduct();
    await expect(create([{ productId: pid, quantity: Q(1) }], { input: { customer: { name: "" } } })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(create([{ productId: pid, quantity: Q(1) }], { input: { source: "telepathy" } })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(create([{ productId: pid, quantity: Q(1) }], { input: { source: "other" } })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(create([])).rejects.toMatchObject({ code: "invalid-input" });
    await expect(create([{ productId: pid, quantity: Q(1) }, { productId: pid, quantity: Q(1) }])).rejects.toMatchObject({ code: "invalid-input" });
    await expect(create([{ productId: "../../biz-b/products/x", quantity: Q(1) }])).rejects.toMatchObject({ code: "invalid-input" });
  });
});

describe("gauges", () => {
  it("pending / unpaid / receivables follow create, fulfill and cancel; fulfillment isn't payment", async () => {
    const pid = await stockedProduct({ price: 1000 });
    const a = await create([{ productId: pid, quantity: Q(1) }]);
    const b = await create([{ productId: pid, quantity: Q(2) }]);
    expect(docAt("businesses/biz-a/metrics/current")).toMatchObject({ pendingFulfillment: 2, unpaidOrders: 2 });
    await fulfill(a.orderId);
    await cancel(b.orderId);
    expect(docAt("businesses/biz-a/metrics/current")).toMatchObject({ pendingFulfillment: 0, unpaidOrders: 1 });
    expect(docAt("businesses/biz-a/financialMetrics/current").receivablesOutstanding).toBe(1000);
    expect(docAt("businesses/biz-a/metrics/2026-10-08")).toMatchObject({ orderCount: 2, fulfilledOrders: 1, cancelledOrders: 1 });
  });
});

describe("POST /api/orders", () => {
  const handler = () => createOrdersHandler({ getAdmin: async () => world, now: () => NOW });
  const call = async (uid, body, businessId) => {
    const res = await handler()({ ...request({ uid, businessId, method: "POST" }), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const createBody = (pid, extra = {}) => ({ action: "create", idempotencyKey: nextKey(), order: { customer: { name: "Maria" }, source: "viber", items: [{ productId: pid, quantity: Q(1) }], ...extra } });

  it("401 before anything else", async () => {
    expect((await handler()({ ...request({ method: "POST" }), body: "{nope" })).statusCode).toBe(401);
  });

  it("staff create + fulfill; can't cancel or discount; owner can", async () => {
    const pid = await stockedProduct();
    const made = await call(world.uids.staffa, createBody(pid));
    expect(made.status).toBe(201);
    expect((await call(world.uids.staffa, createBody(pid, { discount: 100 }))).body.error).toBe("discount-not-allowed");
    expect((await call(world.uids.staffa, { action: "cancel", orderId: made.body.orderId, reason: "nope nope" })).status).toBe(403);
    const fulfilled = await call(world.uids.staffa, { action: "fulfill", orderId: made.body.orderId });
    expect(fulfilled.status).toBe(200);
    expect(fulfilled.body.financials).toBeUndefined(); // staff don't see COGS
    const other = await call(world.uids.ownera, createBody(pid, { discount: 100 }));
    expect(other.status).toBe(201);
    const ownerFulfil = await call(world.uids.ownera, { action: "fulfill", orderId: other.body.orderId });
    expect(ownerFulfil.body.financials).toMatchObject({ grossSales: 7500, discount: 100, netSales: 7400, cogs: 5000, grossProfit: 2400 });
  });

  it("a member without orders.create / orders.update / orders.fulfill is refused each", async () => {
    const pid = await stockedProduct();
    const { body } = await call(world.uids.ownera, createBody(pid));
    const viewer = await ensureAuthUser({ auth: world.auth, email: "viewer@t.test", name: "Viewer" });
    await addMember({ ...world, businessId: "biz-a", uid: viewer.uid, email: viewer.email, name: "Viewer", roleTemplate: "staff", permissionOverrides: { revoke: ["orders.create", "orders.update", "orders.fulfill"] } });
    expect((await call(viewer.uid, createBody(pid))).status).toBe(403);
    expect((await call(viewer.uid, { action: "update", orderId: body.orderId, order: { customer: { name: "X" }, source: "viber", items: [{ productId: pid, quantity: Q(2) }] } })).status).toBe(403);
    expect((await call(viewer.uid, { action: "fulfill", orderId: body.orderId })).status).toBe(403);
  });

  it("duplicate submissions of the same request return the same order", async () => {
    const pid = await stockedProduct();
    const body = createBody(pid);
    const [a, b] = await Promise.all([call(world.uids.staffa, body), call(world.uids.staffa, body)]);
    expect(a.body.orderId).toBe(b.body.orderId);
    expect(product(pid).reserved).toBe(Q(1));
  });

  it("strict payloads: unknown top-level fields, forged prices", async () => {
    const pid = await stockedProduct();
    expect((await call(world.uids.ownera, { ...createBody(pid), total: 1 })).status).toBe(400);
    expect((await call(world.uids.ownera, createBody(pid, { items: [{ productId: pid, quantity: Q(1), unitPrice: 1 }] }))).status).toBe(400);
    expect((await call(world.uids.ownera, { action: "create", order: createBody(pid).order })).status).toBe(400); // no key
    expect((await call(world.uids.ownera, { action: "fulfill", orderId: "../x" })).status).toBe(400);
  });

  it("Orders or Inventory module off -> refused", async () => {
    const pid = await stockedProduct();
    await updateOverrides({ ...world, businessId: "biz-a", set: { modules: { orders: false } }, actor: "t", reason: "orders off" });
    expect((await call(world.uids.ownera, createBody(pid))).status).toBe(403);
    await updateOverrides({ ...world, businessId: "biz-a", set: { modules: { orders: true, inventory: false } }, actor: "t", reason: "inventory off" });
    expect((await call(world.uids.ownera, createBody(pid))).status).toBe(403);
  });

  it("suspended and cancelled businesses can't write orders", async () => {
    expect((await call(world.uids.owners, { action: "fulfill", orderId: "aaaaaaaaaaaaaaaaaaaa" })).body.error).toBe("read-only");
    expect((await call(world.uids.ownerx, { action: "fulfill", orderId: "aaaaaaaaaaaaaaaaaaaa" })).status).toBe(403);
  });

  it("cross-tenant: selector to B refused; A's call can't touch B's order", async () => {
    const B = tenantDb(world.db, "biz-b");
    const { productId: bp } = await createProduct({ db: world.db, tenant: B, FieldValue, actor, input: { sku: "B-1", name: "B", unit: "pcs", sellingPrice: 100, reorderLevel: 0 } });
    await recordMovement({ db: world.db, tenant: B, FieldValue, productId: bp, actor, movement: { type: "opening", quantity: Q(10), unitCost: 50, note: "x" } });
    const bOrder = await createOrder({ db: world.db, tenant: B, FieldValue, business: { ...MANILA, id: "biz-b" }, entitlements: docAt("businesses/biz-b").entitlements, input: { customer: { name: "B cust" }, source: "phone", items: [{ productId: bp, quantity: Q(1) }] }, idempotencyKey: nextKey(), actor, canDiscount: false, now: NOW });
    expect((await call(world.uids.ownera, { action: "fulfill", orderId: bOrder.orderId }, "biz-b")).body.error).toBe("business-access-denied");
    expect((await call(world.uids.ownera, { action: "cancel", orderId: bOrder.orderId, reason: "hijack" })).status).toBe(404);
    expect((await call(world.uids.ownera, createBody(bp))).status).toBe(404); // B's product id isn't in A
    expect(docAt(`businesses/biz-b/orders/${bOrder.orderId}`).fulfillmentStatus).toBe("pending");
  });
});
