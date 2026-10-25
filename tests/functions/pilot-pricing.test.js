// Customer-specific prices (2026-10-25): a product has its normal price; a
// saved customer may have a special one. The SERVER prices each line when
// it's added (special if there is one, else normal); the order then keeps
// that price forever. The order discount (orders.discount) stays the only
// manual override.

import { describe, it, expect, beforeEach } from "vitest";
import { createOrder, updateOrder, fulfillOrder } from "../../netlify/functions/_lib/orders.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createCustomer, setCustomerPrice, clearCustomerPrice } from "../../netlify/functions/_lib/customers.js";
import { createCustomersHandler } from "../../netlify/functions/customers.js";
import { createOrdersHandler } from "../../netlify/functions/orders.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-owner", name: "Owner", email: "o@t.test" };
const BIZ = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" };
const NOW = new Date("2026-10-25T05:00:00Z");
let world;
let A;
let n = 0;
beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});
const docAt = (p) => world.db.docs.get(p);
const c = () => ({ db: world.db, tenant: A, FieldValue, actor });
const key = () => `price-key-${String(++n).padStart(10, "0")}`;
async function product(name, price) {
  const { productId } = await createProduct({ ...c(), input: { sku: `PR-${++n}`, name, unit: "pcs", sellingPrice: price, reorderLevel: 0 } });
  await recordMovement({ ...c(), productId, movement: { type: "opening", quantity: Q(100), unitCost: Math.round(price / 2), note: "count" } });
  return productId;
}
const customer = async (name) => (await createCustomer({ ...c(), input: { name } })).customerId;
const order = (customerId, items, extra = {}) => createOrder({ ...c(), business: BIZ, entitlements: docAt("businesses/biz-a").entitlements, input: { ...(customerId ? { customerId } : {}), customer: { name: customerId ? "Saved" : "Walk-in" }, source: "phone", items: items.map(([productId, q]) => ({ productId, quantity: Q(q) })), ...extra }, idempotencyKey: key(), canDiscount: extra.discount > 0, canLinkCustomers: true, now: NOW });
const lines = (orderId) => docAt(`businesses/biz-a/orders/${orderId}`).items.map((l) => [l.name, l.unitPrice, l.customerPrice === true]);

describe("special prices on orders", () => {
  it("special for that customer, normal for others and walk-ins; totals follow", async () => {
    const siomai = await product("Siomai", 5500);
    const tocino = await product("Tocino", 12000);
    const abc = await customer("ABC Restaurant");
    const juan = await customer("Juan Store");
    await setCustomerPrice({ ...c(), customerId: abc, productId: siomai, price: 5000 });
    const o1 = await order(abc, [[siomai, 10], [tocino, 2]]);
    expect(lines(o1.orderId)).toEqual([["Siomai", 5000, true], ["Tocino", 12000, false]]);
    expect(docAt(`businesses/biz-a/orders/${o1.orderId}`)).toMatchObject({ subtotal: 74000, total: 74000, balance: 74000 });
    expect(docAt(`businesses/biz-a/customers/${abc}`).stats.outstandingBalance).toBe(74000);
    expect(lines((await order(juan, [[siomai, 1]])).orderId)).toEqual([["Siomai", 5500, false]]);
    expect(lines((await order(null, [[siomai, 1]])).orderId)).toEqual([["Siomai", 5500, false]]);
  });
  it("a later price change never rewrites an order; new orders use the new price; removing it brings back the normal price", async () => {
    const siomai = await product("Siomai", 5500);
    const abc = await customer("ABC Restaurant");
    await setCustomerPrice({ ...c(), customerId: abc, productId: siomai, price: 5000 });
    const first = await order(abc, [[siomai, 2]]);
    await setCustomerPrice({ ...c(), customerId: abc, productId: siomai, price: 4800 });
    expect(lines(first.orderId)).toEqual([["Siomai", 5000, true]]);
    expect(docAt(`businesses/biz-a/orders/${first.orderId}`).total).toBe(10000);
    expect(lines((await order(abc, [[siomai, 1]])).orderId)).toEqual([["Siomai", 4800, true]]);
    await clearCustomerPrice({ ...c(), customerId: abc, productId: siomai });
    expect(lines((await order(abc, [[siomai, 1]])).orderId)).toEqual([["Siomai", 5500, false]]);
    expect(lines(first.orderId)).toEqual([["Siomai", 5000, true]]);
    // Every change is kept on the price record.
    expect(docAt(`businesses/biz-a/customerPrices/${abc}_${siomai}`).history.map((h) => [h.from, h.to])).toEqual([[null, 5000], [5000, 4800], [4800, null]]);
  });
  it("editing an order: lines already on it keep their price; a product added now gets the customer's price; a fulfilled correction too", async () => {
    const siomai = await product("Siomai", 5500);
    const tocino = await product("Tocino", 12000);
    const abc = await customer("ABC Restaurant");
    await setCustomerPrice({ ...c(), customerId: abc, productId: siomai, price: 5000 });
    const o = await order(abc, [[siomai, 2]]);
    await setCustomerPrice({ ...c(), customerId: abc, productId: siomai, price: 4000 });
    await setCustomerPrice({ ...c(), customerId: abc, productId: tocino, price: 11000 });
    const rev = docAt(`businesses/biz-a/orders/${o.orderId}`).revision;
    await updateOrder({ ...c(), business: BIZ, orderId: o.orderId, input: { customerId: abc, customer: { name: "ABC Restaurant" }, source: "phone", items: [{ productId: siomai, quantity: Q(3) }, { productId: tocino, quantity: Q(1) }] }, expectedRevision: rev, canDiscount: false, canLinkCustomers: true });
    expect(lines(o.orderId)).toEqual([["Siomai", 5000, true], ["Tocino", 11000, true]]);
    expect(docAt(`businesses/biz-a/orders/${o.orderId}`).total).toBe(26000);
    // Fulfilled, then corrected with a new product: priced for the customer.
    const tapa = await product("Tapa", 14500);
    await setCustomerPrice({ ...c(), customerId: abc, productId: tapa, price: 13000 });
    await fulfillOrder({ ...c(), business: BIZ, orderId: o.orderId, now: NOW });
    const rev2 = docAt(`businesses/biz-a/orders/${o.orderId}`).revision;
    await updateOrder({ ...c(), business: BIZ, orderId: o.orderId, input: { customerId: abc, customer: { name: "ABC Restaurant" }, source: "phone", items: [{ productId: siomai, quantity: Q(3) }, { productId: tocino, quantity: Q(1) }, { productId: tapa, quantity: Q(1) }] }, expectedRevision: rev2, canDiscount: false, canLinkCustomers: true, canCorrect: true, reason: "Added tapa" });
    expect(lines(o.orderId)).toEqual([["Siomai", 5000, true], ["Tocino", 11000, true], ["Tapa", 13000, true]]);
  });
  it("the browser never sets a price: a line price sent in is refused; the discount (by someone allowed) is the only override", async () => {
    const siomai = await product("Siomai", 5500);
    const abc = await customer("ABC Restaurant");
    await setCustomerPrice({ ...c(), customerId: abc, productId: siomai, price: 5000 });
    const call = async (body, uid = world.uids.ownera) => {
      const res = await createOrdersHandler({ getAdmin: async () => world, now: () => NOW })({ ...request({ uid, businessId: "biz-a", method: "POST" }), body: JSON.stringify(body) });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    };
    const sneaky = await call({ action: "create", idempotencyKey: key(), order: { customerId: abc, customer: { name: "ABC" }, source: "phone", items: [{ productId: siomai, quantity: Q(1), unitPrice: 1 }] } });
    expect(sneaky.status).toBe(400);
    const okRes = await call({ action: "create", idempotencyKey: key(), order: { customerId: abc, customer: { name: "ABC" }, source: "phone", items: [{ productId: siomai, quantity: Q(2) }], discount: 1000 } });
    expect(okRes.status, JSON.stringify(okRes.body)).toBe(201);
    expect(docAt(`businesses/biz-a/orders/${okRes.body.orderId}`)).toMatchObject({ subtotal: 10000, discount: 1000, total: 9000 });
    expect((await call({ action: "create", idempotencyKey: key(), order: { customerId: abc, customer: { name: "ABC" }, source: "phone", items: [{ productId: siomai, quantity: Q(2) }], discount: 1000 } }, world.uids.staffa)).body.error).toBe("discount-not-allowed");
  });
});

describe("managing special prices (customers.manage), one business at a time", () => {
  it("owner sets / clears (customers.manage); bad prices refused; another business can't touch these customers", async () => {
    const siomai = await product("Siomai", 5500);
    const abc = await customer("ABC Restaurant");
    const call = async (body, uid, businessId = "biz-a") => {
      const res = await createCustomersHandler({ getAdmin: async () => world })({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    };
    expect((await call({ action: "setPrice", customerId: abc, productId: siomai, price: 5000 }, world.uids.ownera)).body).toMatchObject({ success: true, price: 5000, defaultPrice: 5500 });
    for (const price of [0, -1, 1.5, "50"]) expect((await call({ action: "setPrice", customerId: abc, productId: siomai, price }, world.uids.ownera)).status, String(price)).toBe(400);
    // biz-b, same ids: its own (non-existent) customer.
    expect((await call({ action: "setPrice", customerId: abc, productId: siomai, price: 1 }, world.uids.ownerb, "biz-b")).status).toBe(404);
    expect([...world.db.docs.keys()].filter((k) => k.startsWith("businesses/biz-b/customerPrices/"))).toEqual([]);
    expect(docAt(`businesses/biz-a/customerPrices/${abc}_${siomai}`).price).toBe(5000);
    expect((await call({ action: "clearPrice", customerId: abc, productId: siomai }, world.uids.ownera)).body).toMatchObject({ cleared: true });
    expect(docAt(`businesses/biz-a/customerPrices/${abc}_${siomai}`).active).toBe(false);
  });
});
