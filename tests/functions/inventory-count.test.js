// Update stock = enter the stock on hand counted (2026-10-22). The server
// turns the count into an ordinary adjustment (count − on hand, from the
// state read in its own transaction): balances, reserved stock, the moving
// average, history and permissions behave exactly as before.

import { describe, it, expect, beforeEach } from "vitest";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createInventoryHandler } from "../../netlify/functions/inventory.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";
import { countMovement } from "../../shared/inventory.js";
// Stock actions need a request key (2026-10-25): a fresh one per call unless the test sets its own.
let stockKeyN = 0;
const withStockKey = (handler) => (event) => {
  let body = null;
  try {
    body = JSON.parse(event.body);
  } catch {
    return handler(event);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || "idempotencyKey" in body || !["receipt", "opening", "count", "adjustment_increase", "adjustment_decrease"].includes(body.action)) return handler(event);
  return handler({ ...event, body: JSON.stringify({ ...body, idempotencyKey: `test-stock-key-${String(++stockKeyN).padStart(6, "0")}` }) });
};


const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-owner", name: "Owner A", email: "owner@t.test" };
let world;
let A;
beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});
const docAt = (p) => world.db.docs.get(p);
const movements = (productId) => [...world.db.docs.entries()].filter(([p, d]) => p.startsWith("businesses/biz-a/inventoryTransactions/") && d.productId === productId).map(([p, d]) => ({ id: p.split("/").at(-1), ...d })).sort((a, b) => a.seq - b.seq);
const costOf = (id) => docAt(`businesses/biz-a/inventoryTransactionCosts/${id}`);
const product = (id) => docAt(`businesses/biz-a/products/${id}`);
const inventory = withStockKey(createInventoryHandler({ getAdmin: async () => world }));
const post = async (body, uid = world.uids.ownera) => {
  const res = await inventory({ ...request({ uid, businessId: "biz-a", method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
async function stocked(unit = "pcs", onHand = Q(50), unitCost = 2000) {
  const { productId } = await createProduct({ db: world.db, tenant: A, FieldValue, actor, input: { sku: `C-${unit}-${Math.random().toString(36).slice(2, 7)}`, name: "Chicken Wings", unit, sellingPrice: 25000, reorderLevel: 0 } });
  await recordMovement({ db: world.db, tenant: A, FieldValue, productId, actor, movement: { type: "opening", quantity: onHand, unitCost, note: "count" } });
  return productId;
}

describe("Update stock: the count becomes the adjustment", () => {
  it("50 → 47 records −3; 47 → 55 records +8; each movement keeps the count, reason, note and who", async () => {
    const id = await stocked();
    const r1 = await post({ action: "count", productId: id, onHand: Q(47), reason: "count_correction" });
    expect(r1.status).toBe(200);
    expect(r1.body.balance).toMatchObject({ onHand: Q(47), available: Q(47) });
    const r2 = await post({ action: "count", productId: id, onHand: Q(55), reason: "found", note: "Back shelf" });
    expect(r2.body.balance.onHand).toBe(Q(55));
    const [, dec, inc] = movements(id);
    expect(dec).toMatchObject({ type: "adjustment_decrease", label: "Adjustment", quantity: Q(3), onHandDelta: -Q(3), onHandBefore: Q(50), onHandAfter: Q(47), countedOnHand: Q(47), reason: "count_correction", note: null });
    expect(inc).toMatchObject({ type: "adjustment_increase", quantity: Q(8), onHandDelta: Q(8), onHandBefore: Q(47), onHandAfter: Q(55), countedOnHand: Q(55), reason: "found", note: "Back shelf" });
    expect(dec.actor).toMatchObject({ name: expect.any(String) });
  });

  it("average cost: a decrease leaves it unchanged; an increase comes in at the current average", async () => {
    const id = await stocked("pcs", Q(50), 2000); // ₱20.00 each
    const avg = () => docAt(`businesses/biz-a/productCosts/${id}`).avgCostUnits;
    const before = avg();
    await post({ action: "count", productId: id, onHand: Q(40), reason: "damaged" });
    expect(avg()).toBe(before);
    await post({ action: "count", productId: id, onHand: Q(60), reason: "found" });
    expect(avg()).toBe(before);
    const [, dec, inc] = movements(id);
    expect(costOf(dec.id)).toMatchObject({ avgCostBefore: before, avgCostAfter: before, costConsumed: 20000 });
    expect(costOf(inc.id)).toMatchObject({ avgCostBefore: before, avgCostAfter: before });
    expect(docAt(`businesses/biz-a/productCosts/${id}`).inventoryValue).toBe(120000);
  });

  it("the same number is a clear no-change; zero is fine; negatives, fractions of a pcs and bad input are refused", async () => {
    const id = await stocked();
    const same = await post({ action: "count", productId: id, onHand: Q(50), reason: "count_correction" });
    expect([same.status, same.body.error, same.body.message]).toEqual([409, "no-change", "Stock on hand is already 50 pcs. Nothing changed."]);
    expect(movements(id)).toHaveLength(1);
    for (const onHand of [-Q(1), Q(1) + 500, "47", null]) {
      const r = await post({ action: "count", productId: id, onHand, reason: "count_correction" });
      expect([r.status, r.body.error]).toEqual([400, "invalid-quantity"]);
    }
    expect((await post({ action: "count", productId: id, onHand: 0, reason: "lost" })).body.balance).toMatchObject({ onHand: 0, available: 0 });
    expect(product(id).isLowStock).toBe(true);
  });

  it("decimal units keep their precision (kg: up to 3 decimals)", async () => {
    const id = await stocked("kg", 12500); // 12.5 kg
    expect((await post({ action: "count", productId: id, onHand: 12250, reason: "count_correction" })).body.balance.onHand).toBe(12250);
    expect(movements(id).at(-1)).toMatchObject({ type: "adjustment_decrease", quantity: 250 });
  });

  it("reserved stock: the count can't go below what open orders set aside", async () => {
    const id = await stocked();
    await recordMovement({ db: world.db, tenant: A, FieldValue, productId: id, actor, movement: { type: "reservation", quantity: Q(10) } });
    const low = await post({ action: "count", productId: id, onHand: Q(9), reason: "lost" });
    expect([low.status, low.body.error]).toEqual([409, "insufficient-stock"]);
    expect(low.body.message).toBe("10 pcs are set aside for open orders, so stock on hand can't be less than that");
    const ok = await post({ action: "count", productId: id, onHand: Q(10), reason: "lost" });
    expect(ok.body.balance).toMatchObject({ onHand: Q(10), reserved: Q(10), available: 0 });
  });

  it("same rules as any adjustment: Reason required (Other needs a note), inventory.adjust only, no stock before an opening", async () => {
    const id = await stocked();
    expect((await post({ action: "count", productId: id, onHand: Q(40) })).status).toBe(400);
    expect((await post({ action: "count", productId: id, onHand: Q(40), reason: "other" })).body.message).toBe("Explain the adjustment in the note.");
    expect((await post({ action: "count", productId: id, onHand: Q(40), reason: "count_correction" }, world.uids.staffa)).status).toBe(403);
    expect((await post({ action: "count", productId: id, onHand: Q(40), reason: "count_correction", quantity: Q(1) })).status).toBe(400);
    const { productId: fresh } = await createProduct({ db: world.db, tenant: A, FieldValue, actor, input: { sku: "NEW-1", name: "New", unit: "pcs", sellingPrice: 100, reorderLevel: 0 } });
    expect((await post({ action: "count", productId: fresh, onHand: Q(5), reason: "found" })).body.error).toBe("no-cost-basis");
  });

  it("countMovement is pure: it reads only the state it's given", () => {
    const state = { unit: "pcs", onHand: Q(50), reserved: 0 };
    expect(countMovement(state, { type: "count", onHand: Q(47), reason: "damaged" })).toEqual({ type: "adjustment_decrease", quantity: Q(3), countedOnHand: Q(47), reason: "damaged" });
    expect(countMovement(state, { type: "count", onHand: Q(55), reason: "found" })).toMatchObject({ type: "adjustment_increase", quantity: Q(5) });
  });
});
