// Several items on ONE order (2026-10-22, New Order "+ Add Item"): the
// order engine saves every line under one order number with the right
// totals and stock reservations; editing the open order later (quantities
// changed, an item removed, one added) reconciles the reservations and the
// totals, and the change is in the order's history.

import { describe, it, expect, beforeEach } from "vitest";
import { createOrder, updateOrder } from "../../netlify/functions/_lib/orders.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-carlo", name: "Carlo", email: "c@t.test" };
const BIZ = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" };
const NOW = new Date("2026-10-22T05:00:00Z");
let world;
let A;
beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});
const docAt = (p) => world.db.docs.get(p);
const product = (id) => docAt(`businesses/biz-a/products/${id}`);
async function stocked(sku, name, price) {
  const { productId } = await createProduct({ db: world.db, tenant: A, FieldValue, actor, input: { sku, name, unit: "pcs", sellingPrice: price, reorderLevel: 0 } });
  await recordMovement({ db: world.db, tenant: A, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(20), unitCost: price / 2, note: "count" } });
  return productId;
}

describe("one order, several items", () => {
  it("Coke × 5, Sprite × 3, Royal × 2 at ₱50: ONE order number, ₱500, each item reserved; editing it reconciles stock and totals, with history", async () => {
    const coke = await stocked("COKE-250", "Coke 250ml", 5000);
    const sprite = await stocked("SPRITE-250", "Sprite 250ml", 5000);
    const royal = await stocked("ROYAL-250", "Royal 250ml", 5000);
    const ent = docAt("businesses/biz-a").entitlements;
    const r = await createOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, entitlements: ent, input: { customer: { name: "Maria" }, source: "viber", items: [{ productId: coke, quantity: Q(5) }, { productId: sprite, quantity: Q(3) }, { productId: royal, quantity: Q(2) }] }, idempotencyKey: "items-key-0000000001", actor, canDiscount: false, now: NOW });
    const orders = [...world.db.docs.keys()].filter((p) => /^businesses\/biz-a\/orders\/[^/]+$/.test(p));
    expect(orders).toHaveLength(1);
    const o = docAt(`businesses/biz-a/orders/${r.orderId}`);
    expect(o.orderNumber).toBe(r.orderNumber);
    expect(o.items.map((l) => [l.name, l.quantity, l.unitPrice, l.lineSubtotal])).toEqual([["Coke 250ml", Q(5), 5000, 25000], ["Sprite 250ml", Q(3), 5000, 15000], ["Royal 250ml", Q(2), 5000, 10000]]);
    expect([o.subtotal, o.discount, o.total, o.balance]).toEqual([50000, 0, 50000, 50000]);
    expect([coke, sprite, royal].map((id) => [product(id).reserved, product(id).available])).toEqual([[Q(5), Q(15)], [Q(3), Q(17)], [Q(2), Q(18)]]);
    // Edit after creating: Coke 5 → 4, Sprite removed, Royal 2 → 6.
    await updateOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId: r.orderId, input: { customer: { name: "Maria" }, source: "viber", items: [{ productId: coke, quantity: Q(4) }, { productId: royal, quantity: Q(6) }] }, expectedRevision: o.revision, actor, canDiscount: false });
    const after = docAt(`businesses/biz-a/orders/${r.orderId}`);
    expect(after.items.map((l) => [l.name, l.quantity])).toEqual([["Coke 250ml", Q(4)], ["Royal 250ml", Q(6)]]);
    expect([after.total, after.balance]).toEqual([50000, 50000]);
    expect([coke, sprite, royal].map((id) => product(id).reserved)).toEqual([Q(4), 0, Q(6)]);
    expect(after.statusHistory.at(-1).type).toBe("edited");
  });

  it("the same product twice in one order is refused (the form combines them first); more than in stock is refused", async () => {
    const coke = await stocked("COKE-250", "Coke 250ml", 5000);
    const ent = docAt("businesses/biz-a").entitlements;
    const make = (items, k) => createOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, entitlements: ent, input: { customer: { name: "Maria" }, items }, idempotencyKey: `items-key-000000000${k}`, actor, canDiscount: false, now: NOW });
    await expect(make([{ productId: coke, quantity: Q(1) }, { productId: coke, quantity: Q(2) }], 2)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(make([{ productId: coke, quantity: Q(21) }], 3)).rejects.toMatchObject({ code: "insufficient-stock" });
  });
});
