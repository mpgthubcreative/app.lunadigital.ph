// Reseller Package update (2026-11-03): orders stay correctable after
// fulfillment, customers typed on an order land in Customers once, the menus
// hide tracked products with nothing available, and the Owner sets each
// line's final commission right in New Order.
//   reverse   fulfilled -> Pending / Preparing / Ready: tracked units come
//             back AND are set aside again; sales / COGS leave the
//             fulfillment day; fulfilling again takes stock once
//   cancel    a fulfilled order: units come back free; never with payments
//   delete    only an order with no history (never fulfilled, no payments)
//   customers same name + same phone / address = that customer; same name
//             only is never a match; the Owner may create a new one
//   commission per line: calculated kept, final = the Owner's override;
//             earned = final × verified ÷ total; never below what's paid

import { describe, it, expect, beforeEach } from "vitest";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { createResellersHandler } from "../../netlify/functions/resellers.js";
import { createResellerMenuHandler } from "../../netlify/functions/reseller-menu.js";
import { createOrdersHandler } from "../../netlify/functions/orders.js";
import { createStorefrontHandler } from "../../netlify/functions/storefront.js";
import { createStoreHandler } from "../../netlify/functions/store.js";
import { createReportsHandler } from "../../netlify/functions/reports.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { recordPayment, voidPayment } from "../../netlify/functions/_lib/payments.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const setup = { uid: "u-setup", name: "Setup", email: "" };
const NOW = new Date("2026-10-15T02:00:00Z");
const DAY = "2026-10-15";
let world;
let k = 0;
const key = () => `rev-key-${String(++k).padStart(12, "0")}`;
const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const docAt = (p) => world.db.docs.get(p);
const docsUnder = (prefix) => [...world.db.docs.entries()].filter(([p]) => p.startsWith(prefix)).map(([p, d]) => ({ id: p.split("/").pop(), ...d }));
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};

beforeEach(async () => {
  world = await buildWorld();
  for (const [id, name] of [["res-a", "Res A"], ["res-b", "Res B"]]) {
    await createBusiness({ ...world, name, planId: "reseller-basic", workspaceTemplateId: "reseller", businessId: id });
    for (const [role, extra] of [["owner", { isAccountOwner: true }], ["staff", {}]]) {
      const user = await ensureAuthUser({ auth: world.auth, email: `${role}.${id}@t.test`, name: `${role} ${id}` });
      world.uids[`${role}-${id}`] = user.uid;
      await addMember({ ...world, businessId: id, uid: user.uid, email: user.email, name: `${role} ${id}`, roleTemplate: role, ...extra });
    }
  }
});

const handlerCall = (create) => async (who, body, businessId = "res-a") => {
  const res = await create(deps())({ ...request({ uid: world.uids[`${who}-${businessId}`], businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const orders = handlerCall(createOrdersHandler);
const resellers = handlerCall(createResellersHandler);
const storefront = handlerCall(createStorefrontHandler);
async function menu(body) {
  const res = await createResellerMenuHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function store(body) {
  const res = await createStoreHandler(deps())({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": "203.0.113.9" }, body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function product(businessId, { sku, name, price, cost = 0, qty = 10, track = true }) {
  const tenant = tenantDb(world.db, businessId);
  const { productId } = await createProduct({ db: world.db, tenant, FieldValue, actor: setup, input: { sku, name, unit: "pcs", sellingPrice: price, reorderLevel: 0 }, trackInventory: track });
  if (track && qty) await recordMovement({ db: world.db, tenant, FieldValue, productId, actor: setup, movement: { type: "opening", quantity: Q(qty), unitCost: cost, note: "count" } });
  return productId;
}
const stockOf = (productId, businessId = "res-a") => {
  const p = docAt(`businesses/${businessId}/products/${productId}`);
  return { onHand: p.onHand, reserved: p.reserved, available: p.available };
};
const movesOf = (productId, businessId = "res-a") => docsUnder(`businesses/${businessId}/inventoryTransactions/`).filter((m) => m.productId === productId);
const orderAt = (orderId, businessId = "res-a") => docAt(`businesses/${businessId}/orders/${orderId}`);
const create = async (order, who = "owner", businessId = "res-a") => ok(await orders(who, { action: "create", idempotencyKey: key(), order: { source: "viber", ...order } }, businessId), 201);
const customersOf = (businessId = "res-a") => docsUnder(`businesses/${businessId}/customers/`);
async function reseller(name, businessId = "res-a") {
  const r = ok(await resellers("owner", { action: "create", reseller: { name } }, businessId), 201);
  return { id: r.resellerId, token: r.path.split("#")[1] };
}
let refN = 0;
const customerPays = (orderId, amount, businessId = "res-a") =>
  recordPayment({ db: world.db, bucket: world.bucket, tenant: tenantDb(world.db, businessId), FieldValue, business: { id: businessId, timezone: "Asia/Manila" }, orderId, input: { amount, method: "cash", reference: `REV-${++refN}` }, actor: setup, canVerify: true, now: NOW });
const fin = () => docAt(`businesses/res-a/financialMetrics/${DAY}`);
const ops = () => docAt(`businesses/res-a/metrics/${DAY}`);

describe("reverse a fulfillment: tracked stock", () => {
  it("10 on hand, order 2: fulfilled → 8; reversed to Ready → 10 on hand, 2 set aside again; fulfilled again → 8 (never twice); sales / COGS follow; history, audit and movements kept", async () => {
    const p = await product("res-a", { sku: "T1", name: "Tracked", price: 20000, cost: 12000, qty: 10 });
    const { orderId } = await create({ customer: { name: "Walk-in" }, items: [{ productId: p, quantity: Q(2) }] });
    expect(stockOf(p)).toEqual({ onHand: Q(10), reserved: Q(2), available: Q(8) });
    ok(await orders("owner", { action: "fulfill", orderId }));
    expect(stockOf(p)).toEqual({ onHand: Q(8), reserved: 0, available: Q(8) });
    expect(fin()).toMatchObject({ grossSales: 40000, cogs: 24000 });
    expect(ops().fulfilledOrders).toBe(1);

    // A reason is required; Staff (no orders.correct) can't reverse.
    expect((await orders("owner", { action: "reopen", orderId, stage: "ready" })).status).toBe(400);
    expect((await orders("staff", { action: "reopen", orderId, stage: "ready", reason: "Not picked up" })).status).toBe(403);
    const r = ok(await orders("owner", { action: "reopen", orderId, stage: "ready", reason: "Marked fulfilled by mistake" }));
    expect(r).toMatchObject({ fulfillmentStatus: "ready", reversedDay: DAY });
    expect(stockOf(p)).toEqual({ onHand: Q(10), reserved: Q(2), available: Q(8) });
    expect(orderAt(orderId)).toMatchObject({ fulfillmentStatus: "ready", fulfilledDay: null, fulfilledAt: null });
    expect(orderAt(orderId).statusHistory.at(-1)).toMatchObject({ type: "reopened", from: "fulfilled", to: "ready", reason: "Marked fulfilled by mistake", actor: { name: "owner res-a" } });
    expect(fin()).toMatchObject({ grossSales: 0, cogs: 0 });
    expect(ops().fulfilledOrders).toBe(0);
    expect(docAt("businesses/res-a/metrics/current").pendingFulfillment).toBe(1);
    // The stock came back at the cost the fulfillment booked (₱120 each).
    expect(docAt(`businesses/res-a/productCosts/${p}`).inventoryValue).toBe(10 * 12000);
    const costs = docAt(`businesses/res-a/orderCosts/${orderId}`);
    expect(costs).toMatchObject({ reversed: true, reversals: [{ to: "ready", reason: "Marked fulfilled by mistake", fulfilledDay: DAY, cogs: 24000, netSales: 40000 }] });
    const back = movesOf(p).find((m) => m.type === "unfulfillment");
    expect(back).toMatchObject({ quantity: Q(2), onHandDelta: Q(2), reservedDelta: Q(2), referenceId: orderId, label: "Fulfillment reversed" });
    const audit = docsUnder("businesses/res-a/auditLog/").find((a) => a.type === "order.fulfillment_reversed");
    expect(audit).toMatchObject({ orderId, from: "fulfilled", to: "ready", reason: "Marked fulfilled by mistake", movements: [back.id] });
    // Reversing again (not fulfilled now) is refused.
    expect((await orders("owner", { action: "reopen", orderId, stage: "pending", reason: "again" })).status).toBe(409);

    ok(await orders("owner", { action: "fulfill", orderId }));
    expect(stockOf(p)).toEqual({ onHand: Q(8), reserved: 0, available: Q(8) });
    expect(fin()).toMatchObject({ grossSales: 40000, cogs: 24000 });
    expect(ops().fulfilledOrders).toBe(1);
    expect(movesOf(p).map((m) => m.type).sort()).toEqual(["fulfillment", "fulfillment", "opening", "reservation", "unfulfillment"]);
    const again = docAt(`businesses/res-a/orderCosts/${orderId}`);
    expect(again.reversed).toBeUndefined();
    expect(again).toMatchObject({ cogs: 24000, reversals: [{ to: "ready" }] });
  });

  it("untracked product: fulfil, reverse, fulfil again: never a stock movement; the status still changes", async () => {
    const p = await product("res-a", { sku: "U1", name: "Untracked", price: 20000, track: false });
    const { orderId } = await create({ customer: { name: "Walk-in" }, items: [{ productId: p, quantity: Q(3) }] });
    ok(await orders("owner", { action: "fulfill", orderId }));
    ok(await orders("owner", { action: "reopen", orderId, stage: "pending", reason: "Wrong order" }));
    expect(orderAt(orderId).fulfillmentStatus).toBe("pending");
    ok(await orders("owner", { action: "fulfill", orderId }));
    expect(movesOf(p)).toEqual([]);
    expect(stockOf(p)).toEqual({ onHand: 0, reserved: 0, available: 0 });
    expect(fin().grossSales).toBe(60000);
  });

  it("reversing keeps the customer's payments and the reseller's earned commission exactly as they were", async () => {
    const p = await product("res-a", { sku: "P1", name: "Paid", price: 20000, qty: 10 });
    const riza = await reseller("Riza");
    const r = ok(await menu({ action: "order", token: riza.token, idempotencyKey: key(), order: { customerName: "Ana Lopez", fulfillment: "pickup", items: [{ productId: p, quantity: Q(2), sellingPrice: 25000 }] } }), 201);
    const orderId = docsUnder("businesses/res-a/orders/").find((o) => o.orderNumber === r.orderNumber).id;
    await customerPays(orderId, 20000); // 40% of ₱500
    ok(await orders("owner", { action: "fulfill", orderId }));
    const before = { order: orderAt(orderId), payments: docsUnder("businesses/res-a/payments/"), earned: docAt(`businesses/res-a/resellers/${riza.id}`).earned };
    expect(before.earned).toBe(4000); // ₱100 × 40%
    ok(await orders("owner", { action: "reopen", orderId, stage: "preparing", reason: "Customer hasn't collected it" }));
    expect(docsUnder("businesses/res-a/payments/")).toEqual(before.payments);
    expect(orderAt(orderId)).toMatchObject({ amountPaid: 20000, verifiedPaid: 20000, balance: 30000, paymentStatus: "partial", commission: before.order.commission });
    expect(docAt(`businesses/res-a/resellers/${riza.id}`).earned).toBe(4000);
  });
});

describe("cancel after fulfillment, delete only without history", () => {
  it("cancel a fulfilled order (Owner): stock back free, sales / COGS reversed, cancelled count; refused while it has payments; Staff can't", async () => {
    const p = await product("res-a", { sku: "C1", name: "Cancel me", price: 20000, cost: 10000, qty: 10 });
    const { orderId } = await create({ customer: { name: "Walk-in" }, items: [{ productId: p, quantity: Q(2) }] });
    ok(await orders("owner", { action: "fulfill", orderId }));
    expect((await orders("staff", { action: "cancel", orderId, reason: "Returned" })).status).toBeGreaterThanOrEqual(403);
    ok(await orders("owner", { action: "cancel", orderId, reason: "Customer returned everything" }));
    expect(stockOf(p)).toEqual({ onHand: Q(10), reserved: 0, available: Q(10) });
    expect(orderAt(orderId)).toMatchObject({ fulfillmentStatus: "cancelled", fulfilledDay: null, balance: 0, cancellationReason: "Customer returned everything" });
    expect(orderAt(orderId).statusHistory.at(-1)).toMatchObject({ type: "cancelled", from: "fulfilled", reversed: true });
    expect(fin()).toMatchObject({ grossSales: 0, cogs: 0 });
    expect(ops()).toMatchObject({ fulfilledOrders: 0, cancelledOrders: 1 });
    expect(movesOf(p).find((m) => m.type === "cancel_return")).toMatchObject({ quantity: Q(2), onHandDelta: Q(2), reservedDelta: 0 });

    const { orderId: paidId } = await create({ customer: { name: "Walk-in" }, items: [{ productId: p, quantity: Q(1) }] });
    await customerPays(paidId, 5000);
    ok(await orders("owner", { action: "fulfill", orderId: paidId }));
    expect(ok(await orders("owner", { action: "cancel", orderId: paidId, reason: "Wrong order" }), 409).error).toBe("has-payments");
    expect(docsUnder("businesses/res-a/payments/").filter((x) => x.orderId === paidId)).toHaveLength(1);
    expect(orderAt(paidId).fulfillmentStatus).toBe("fulfilled");
  });

  it("delete: a brand-new unpaid order can go (audit kept); once fulfilled (even reversed) or with any payment record (even voided) it's cancelled instead", async () => {
    const p = await product("res-a", { sku: "D1", name: "Delete", price: 10000, qty: 20 });
    const fresh = await create({ customer: { name: "Walk-in" }, items: [{ productId: p, quantity: Q(1) }] });
    ok(await orders("owner", { action: "delete", orderId: fresh.orderId, reason: "Typed twice" }));
    expect(orderAt(fresh.orderId)).toBeUndefined();
    expect(docsUnder("businesses/res-a/auditLog/").find((a) => a.type === "order.deleted")).toMatchObject({ orderId: fresh.orderId, reason: "Typed twice" });
    expect(stockOf(p)).toEqual({ onHand: Q(20), reserved: 0, available: Q(20) });

    const was = await create({ customer: { name: "Walk-in" }, items: [{ productId: p, quantity: Q(1) }] });
    ok(await orders("owner", { action: "fulfill", orderId: was.orderId }));
    ok(await orders("owner", { action: "reopen", orderId: was.orderId, stage: "pending", reason: "Not shipped yet" }));
    expect(ok(await orders("owner", { action: "delete", orderId: was.orderId }), 409)).toMatchObject({ error: "not-deletable" });
    ok(await orders("owner", { action: "cancel", orderId: was.orderId, reason: "Customer cancelled" }));
    expect(orderAt(was.orderId).fulfillmentStatus).toBe("cancelled");
    expect(stockOf(p)).toEqual({ onHand: Q(20), reserved: 0, available: Q(20) });

    const voided = await create({ customer: { name: "Walk-in" }, items: [{ productId: p, quantity: Q(1) }] });
    const pay = await customerPays(voided.orderId, 5000);
    await voidPayment({ db: world.db, tenant: tenantDb(world.db, "res-a"), FieldValue, business: { timezone: "Asia/Manila" }, paymentId: pay.paymentId, reason: "Wrong order", actor: setup });
    expect(orderAt(voided.orderId).amountPaid).toBe(0);
    expect(ok(await orders("owner", { action: "delete", orderId: voided.orderId }), 409)).toMatchObject({ error: "not-deletable" });
    expect(docAt(`businesses/res-a/payments/${pay.paymentId}`)).toMatchObject({ state: "voided" });
  });
});

describe("New Order: the Owner's reseller sale with a final commission per line", () => {
  async function twoProducts() {
    return { p1: await product("res-a", { sku: "N1", name: "Nipple Tape", price: 20000, cost: 8000 }), p2: await product("res-a", { sku: "N2", name: "Body Tape", price: 15000, cost: 5000 }) };
  }

  it("Owner ₱200 / Sell ₱250 / Final ₱40 and Owner ₱150 / Sell ₱250: calculated ₱150, final ₱140; overrides survive qty and price changes; clearing goes back to calculated; 40% paid earns ₱140 × 40%", async () => {
    const { p1, p2 } = await twoProducts();
    const riza = await reseller("Riza");
    const { orderId } = await create({ customer: { name: "Walk-in" }, resellerId: riza.id, items: [{ productId: p1, quantity: Q(1), sellingPrice: 25000, finalCommission: 4000 }, { productId: p2, quantity: Q(1), sellingPrice: 25000 }] });
    let o = orderAt(orderId);
    expect(o).toMatchObject({ resellerId: riza.id, reseller: { name: "Riza" }, total: 50000, commission: { calculated: 15000, final: 14000, adjusted: true, scope: "lines" } });
    expect(o.items.map((l) => [l.basePrice, l.unitPrice, l.commission, l.finalCommission])).toEqual([[20000, 25000, 5000, 4000], [15000, 25000, 10000, undefined]]);
    expect(docAt(`businesses/res-a/resellers/${riza.id}`).orderCount).toBe(1);

    // Quantity 1 → 2 on Body Tape: calculated moves, the ₱40 override stays.
    const edit = (items) => orders("owner", { action: "update", orderId, expectedRevision: orderAt(orderId).revision, order: { customer: { name: "Walk-in" }, source: "viber", resellerId: riza.id, items } });
    ok(await edit([{ productId: p1, quantity: Q(1), sellingPrice: 25000 }, { productId: p2, quantity: Q(2), sellingPrice: 25000 }]));
    expect(orderAt(orderId).commission).toMatchObject({ calculated: 25000, final: 24000, adjusted: true });
    // Selling price ₱250 → ₱260: calculated ₱60 on that line, final still ₱40.
    ok(await edit([{ productId: p1, quantity: Q(1), sellingPrice: 26000 }, { productId: p2, quantity: Q(2), sellingPrice: 25000 }]));
    o = orderAt(orderId);
    expect(o.items[0]).toMatchObject({ unitPrice: 26000, commission: 6000, finalCommission: 4000 });
    expect(o.commission).toMatchObject({ calculated: 26000, final: 24000 });
    expect(o.statusHistory.at(-1).changes.prices).toEqual([{ lineId: "L1", name: "Nipple Tape", from: 25000, to: 26000 }]);
    // Use calculated commission: null clears the override.
    ok(await edit([{ productId: p1, quantity: Q(1), sellingPrice: 26000, finalCommission: null }, { productId: p2, quantity: Q(2), sellingPrice: 25000 }]));
    o = orderAt(orderId);
    expect(o.items[0].finalCommission).toBeUndefined();
    expect(o.commission).toEqual({ calculated: 26000, final: 26000, adjusted: false });
    expect(o.statusHistory.at(-1).changes.lineCommissions).toEqual([{ lineId: "L1", name: "Nipple Tape", from: 4000, to: null }]);
    // Back to ₱40 on line 1, then the customer pays 40% (verified): ₱(60+...)…
    ok(await edit([{ productId: p1, quantity: Q(1), sellingPrice: 26000, finalCommission: 4000 }, { productId: p2, quantity: Q(2), sellingPrice: 25000 }]));
    o = orderAt(orderId);
    expect(o.commission.final).toBe(24000);
    await customerPays(orderId, Math.round(o.total * 0.4)); // ₱760 × 40% = ₱304
    expect(docAt(`businesses/res-a/resellers/${riza.id}`).earned).toBe(Math.round(24000 * 0.4));
    expect(docsUnder("businesses/res-a/auditLog/").filter((a) => a.type === "order.commission_changed" && a.orderId === orderId).length).toBeGreaterThanOrEqual(3);
  });

  it("THE brief: ₱140 final of ₱150 at 40% paid = ₱56 earned; the report deducts ₱140 once fulfilled", async () => {
    const { p1, p2 } = await twoProducts();
    const riza = await reseller("Riza");
    const { orderId } = await create({ customer: { name: "Walk-in" }, resellerId: riza.id, items: [{ productId: p1, quantity: Q(1), sellingPrice: 25000, finalCommission: 4000 }, { productId: p2, quantity: Q(1), sellingPrice: 25000 }] });
    await customerPays(orderId, 20000); // 40% of ₱500
    expect(docAt(`businesses/res-a/resellers/${riza.id}`).earned).toBe(5600);
    ok(await orders("owner", { action: "fulfill", orderId }));
    const res = await createReportsHandler(deps())({ ...request({ uid: world.uids["owner-res-a"], businessId: "res-a" }), queryStringParameters: { from: "2026-10-01", to: DAY } });
    expect(JSON.parse(res.body).overview).toMatchObject({ grossSales: 50000, resellerCommission: 14000, ownerSales: 36000 });
  });

  it("only the Owner / Admin: Staff can't sell for a reseller or set commission; below the owner price needs that line's commission; a commission can't drop below what's paid out", async () => {
    const { p1 } = await twoProducts();
    const riza = await reseller("Riza");
    expect(ok(await orders("staff", { action: "create", idempotencyKey: key(), order: { customer: { name: "Walk-in" }, source: "viber", resellerId: riza.id, items: [{ productId: p1, quantity: Q(1), sellingPrice: 25000 }] } }), 403)).toMatchObject({ error: "reseller-not-allowed" });
    expect(ok(await orders("owner", { action: "create", idempotencyKey: key(), order: { customer: { name: "Walk-in" }, source: "viber", resellerId: riza.id, items: [{ productId: p1, quantity: Q(1), sellingPrice: 18000 }] } }), 400)).toMatchObject({ error: "below-owner-price" });
    const { orderId } = await create({ customer: { name: "Walk-in" }, resellerId: riza.id, items: [{ productId: p1, quantity: Q(1), sellingPrice: 18000, finalCommission: 0 }] });
    expect(orderAt(orderId).commission).toMatchObject({ calculated: -2000, final: 0, adjusted: true });

    const paid = await create({ customer: { name: "Walk-in" }, resellerId: riza.id, items: [{ productId: p1, quantity: Q(1), sellingPrice: 25000 }] });
    await customerPays(paid.orderId, 25000);
    expect(docAt(`businesses/res-a/resellers/${riza.id}`).earned).toBe(5000);
    ok(await resellers("owner", { action: "pay", resellerId: riza.id, idempotencyKey: key(), payout: { amount: 5000 } }), 201);
    const lower = await orders("owner", { action: "update", orderId: paid.orderId, order: { customer: { name: "Walk-in" }, source: "viber", resellerId: riza.id, items: [{ productId: p1, quantity: Q(1), sellingPrice: 25000, finalCommission: 3000 }] } });
    expect(ok(lower, 409)).toMatchObject({ error: "commission-below-paid" });
    expect(orderAt(paid.orderId).commission.final).toBe(5000);
    expect(docAt(`businesses/res-a/resellers/${riza.id}`)).toMatchObject({ earned: 5000, paid: 5000 });
    // Moving the sale to Direct would take paid-out commission too: refused.
    expect(ok(await orders("owner", { action: "update", orderId: paid.orderId, order: { customer: { name: "Walk-in" }, source: "viber", resellerId: null, items: [{ productId: p1, quantity: Q(1) }] } }), 409)).toMatchObject({ error: "commission-below-paid" });
  });

  it("a whole-order final commission (Reseller & commission) survives edits until the Owner types a line commission, which then decides", async () => {
    const { p1, p2 } = await twoProducts();
    const riza = await reseller("Riza");
    const { orderId } = await create({ customer: { name: "Walk-in" }, resellerId: riza.id, items: [{ productId: p1, quantity: Q(1), sellingPrice: 25000 }, { productId: p2, quantity: Q(1), sellingPrice: 25000 }] });
    ok(await resellers("owner", { action: "editSale", orderId, finalCommission: 12000 }));
    expect(orderAt(orderId).commission).toMatchObject({ calculated: 15000, final: 12000, adjusted: true });
    const edit = (items) => orders("owner", { action: "update", orderId, order: { customer: { name: "Walk-in" }, source: "viber", resellerId: riza.id, items } });
    ok(await edit([{ productId: p1, quantity: Q(2), sellingPrice: 25000 }, { productId: p2, quantity: Q(1), sellingPrice: 25000 }]));
    expect(orderAt(orderId).commission).toMatchObject({ calculated: 20000, final: 12000, adjusted: true });
    ok(await edit([{ productId: p1, quantity: Q(2), sellingPrice: 25000, finalCommission: 8000 }, { productId: p2, quantity: Q(1), sellingPrice: 25000 }]));
    expect(orderAt(orderId).commission).toEqual({ calculated: 20000, final: 18000, adjusted: true, scope: "lines" });
  });

  it("a direct sale stays a direct sale: no owner price, commission or reseller fields; selling price / commission on a direct sale is refused", async () => {
    const { p1 } = await twoProducts();
    const { orderId } = await create({ customer: { name: "Walk-in" }, items: [{ productId: p1, quantity: Q(1) }] });
    const o = orderAt(orderId);
    expect(o.resellerId).toBeUndefined();
    expect(o.items[0]).not.toHaveProperty("basePrice");
    expect((await orders("owner", { action: "create", idempotencyKey: key(), order: { customer: { name: "Walk-in" }, source: "viber", items: [{ productId: p1, quantity: Q(1), sellingPrice: 25000 }] } })).status).toBe(400);
  });
});

describe("customers typed on an order are saved once (same name is a warning, not a match)", () => {
  it("new → saved; same name + same phone (any format) → that customer; same name + different phone → not merged (new only when the Owner chooses); Walk-in → nobody", async () => {
    const p = await product("res-a", { sku: "A1", name: "Item", price: 10000, qty: 50 });
    const line = [{ productId: p, quantity: Q(1) }];
    const first = await create({ customer: { name: "Maria Santos", phone: "0917 123 4567" }, deliveryAddress: "Makati", items: line });
    expect(first.customerSaved).toBe("new");
    const [maria] = customersOf();
    expect(maria).toMatchObject({ name: "Maria Santos", phone: "0917 123 4567", address: "Makati", savedFrom: "order", stats: { orderCount: 1, totalOrdered: 10000, outstandingBalance: 10000, lastOrderNumber: orderAt(first.orderId).orderNumber } });
    expect(orderAt(first.orderId)).toMatchObject({ customerId: maria.id });

    const again = await create({ customer: { name: "maria  santos", phone: "+63 917 123 4567" }, items: line });
    expect(again).toMatchObject({ customerSaved: "matched", customerId: maria.id });
    expect(customersOf()).toHaveLength(1);
    expect(orderAt(again.orderId).customer).toMatchObject({ name: "Maria Santos" });
    expect(docAt(`businesses/res-a/customers/${maria.id}`).stats.orderCount).toBe(2);

    const other = await create({ customer: { name: "Maria Santos", phone: "0999 888 7777" }, deliveryAddress: "Taguig", items: line });
    expect(orderAt(other.orderId).customerId).toBeNull();
    expect(other.customerSaved).toBe("same-name");
    expect(customersOf()).toHaveLength(1);
    const chosen = await create({ customer: { name: "Maria Santos", phone: "0999 888 7777" }, deliveryAddress: "Taguig", newCustomer: true, items: line });
    expect(chosen.customerSaved).toBe("new");
    expect(customersOf().map((c) => [c.name, c.phone]).sort()).toEqual([["Maria Santos", "0917 123 4567"], ["Maria Santos", "0999 888 7777"]]);

    const walkIn = await create({ customer: { name: "Walk-in" }, items: line });
    expect(orderAt(walkIn.orderId).customerId).toBeNull();
    expect(customersOf()).toHaveLength(2);
    // The Customers order history is the existing customerId link.
    expect(docsUnder("businesses/res-a/orders/").filter((o) => o.customerId === maria.id).map((o) => o.id).sort()).toEqual([first.orderId, again.orderId].sort());
  });

  it("same name + same address → that customer (phone added if they had none); same name only → unlinked, never guessed", async () => {
    const p = await product("res-a", { sku: "A2", name: "Item", price: 10000, qty: 50 });
    const line = [{ productId: p, quantity: Q(1) }];
    const juan = await create({ customer: { name: "Juan Cruz" }, deliveryAddress: "BGC, Taguig", items: line });
    const same = await create({ customer: { name: "Juan Cruz", phone: "0918 222 3333" }, deliveryAddress: "bgc taguig", items: line });
    expect(same).toMatchObject({ customerSaved: "matched", customerId: juan.customerId });
    expect(docAt(`businesses/res-a/customers/${juan.customerId}`)).toMatchObject({ phone: "0918 222 3333", phoneKey: "09182223333", revision: 2 });
    expect(docAt(`businesses/res-a/customers/${juan.customerId}`).history.at(-1)).toMatchObject({ type: "edited", label: expect.stringMatching(/Phone added from order/) });

    await create({ customer: { name: "Ana Reyes" }, items: line });
    const nameOnly = await create({ customer: { name: "Ana Reyes" }, items: line });
    expect(orderAt(nameOnly.orderId).customerId).toBeNull();
    expect(customersOf().filter((c) => c.name === "Ana Reyes")).toHaveLength(1);
  });

  it("Riza's private menu order for Ana: Ana is saved in the BUSINESS's Customers, the order stays Riza's; the public menu saves its customer too; another business's look-alike is never used", async () => {
    const p = await product("res-a", { sku: "A3", name: "Item", price: 10000, qty: 50 });
    // res-b has the same name and phone: a different business, never matched.
    const pb = await product("res-b", { sku: "B3", name: "Item", price: 10000, qty: 50 });
    await create({ customer: { name: "Ana Lopez", phone: "0917 000 1111" }, items: [{ productId: pb, quantity: Q(1) }] }, "owner", "res-b");
    const before = customersOf("res-b");
    const riza = await reseller("Riza");
    const r = ok(await menu({ action: "order", token: riza.token, idempotencyKey: key(), order: { customerName: "Ana Lopez", customerPhone: "0917 000 1111", fulfillment: "pickup", items: [{ productId: p, quantity: Q(1), sellingPrice: 12000 }] } }), 201);
    const order = docsUnder("businesses/res-a/orders/").find((o) => o.orderNumber === r.orderNumber);
    const [ana] = customersOf("res-a");
    expect(ana).toMatchObject({ name: "Ana Lopez", phone: "0917 000 1111", stats: { orderCount: 1, totalOrdered: 12000 } });
    expect(order).toMatchObject({ customerId: ana.id, resellerId: riza.id, reseller: { name: "Riza" } });
    expect(docsUnder("businesses/res-a/").some((d) => d.resellerId && d.name === "Ana Lopez")).toBe(false);
    expect(customersOf("res-b")).toEqual(before);

    // The public Share Menu: the customer is saved as well.
    const slug = ok(await storefront("owner", { action: "get" })).settings.slug;
    ok(await storefront("owner", { action: "save", settings: { open: true, pickup: true, delivery: false, paymentMethods: ["cod"] } }));
    const placed = ok(await store({ action: "order", slug, idempotencyKey: `pub-${key()}`, order: { name: "John Reyes", phone: "0917 444 5555", fulfillment: "pickup", paymentMethod: "cod", items: [{ productId: p, quantity: Q(1) }] } }), 201);
    const pubOrder = docsUnder("businesses/res-a/orders/").find((o) => o.orderNumber === placed.order.orderNumber);
    expect(docAt(`businesses/res-a/customers/${pubOrder.customerId}`)).toMatchObject({ name: "John Reyes" });
  });
});

describe("Share Menu and Reseller Menu: tracked products with nothing available are hidden", () => {
  it("available 0 (5 on hand, 5 set aside) → hidden on both; restock → back (Show on Menu was never turned off); untracked always shown", async () => {
    const tracked = await product("res-a", { sku: "S1", name: "Tracked Five", price: 10000, qty: 5 });
    const empty = await product("res-a", { sku: "S2", name: "Never Stocked", price: 10000, qty: 0 });
    const loose = await product("res-a", { sku: "S3", name: "Untracked", price: 10000, track: false });
    const riza = await reseller("Riza");
    const slug = ok(await storefront("owner", { action: "get" })).settings.slug;
    ok(await storefront("owner", { action: "save", settings: { open: true, pickup: true, delivery: false, paymentMethods: ["cod"] } }));
    const names = async () => ({
      store: ok(await store({ action: "view", slug })).products.map((x) => x.name).sort(),
      reseller: ok(await menu({ action: "view", token: riza.token })).products.map((x) => x.name).sort(),
    });
    expect(await names()).toEqual({ store: ["Tracked Five", "Untracked"], reseller: ["Tracked Five", "Untracked"] });
    await create({ customer: { name: "Walk-in" }, items: [{ productId: tracked, quantity: Q(5) }] });
    expect(stockOf(tracked)).toEqual({ onHand: Q(5), reserved: Q(5), available: 0 });
    expect(await names()).toEqual({ store: ["Untracked"], reseller: ["Untracked"] });
    expect(ok(await storefront("owner", { action: "menu" })).hiddenProductIds).toEqual([]);
    await recordMovement({ db: world.db, tenant: tenantDb(world.db, "res-a"), FieldValue, productId: tracked, actor: setup, movement: { type: "receipt", quantity: Q(10), unitCost: 0, note: "restock" } });
    expect(await names()).toEqual({ store: ["Tracked Five", "Untracked"], reseller: ["Tracked Five", "Untracked"] });
    expect([empty, loose]).toHaveLength(2);
  });
});
