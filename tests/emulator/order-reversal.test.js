// Reseller Package update (2026-11-03) on the REAL Firestore emulator: the
// customer match runs a query INSIDE the order transaction, and a reversal
// re-reserves stock and rewrites the cost record in the same transaction.
// Checked against real Firestore (not the unit tests' fake): fulfil →
// reverse → fulfil takes stock once; racing reversals reverse once; a typed
// customer is saved once and reused on a strong match only.

import { beforeAll, describe, it, expect, vi } from "vitest";
import { QTY_SCALE } from "../../shared/quantity.js";
import { PLAN_SEED, computeEntitlements } from "../../shared/index.js";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "order-reversal", name: "Reversal", email: "" };
const BUSINESS = { timezone: "Asia/Manila", orderPrefix: "RV" };
const NOW = new Date("2026-10-08T02:00:00Z");
const ENT = { ...computeEntitlements(PLAN_SEED["reseller-basic"], {}, "reseller"), limits: { ordersPerMonth: 1000 } };
let db, FieldValue, inv, orders, tenantDb;
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

const key = () => `rev-key-${Date.now().toString(36)}-${++keySeq}`.padEnd(20, "x");
function freshTenant() {
  run += 1;
  return tenantDb(db, `ordr-${Date.now().toString(36)}-${run}`);
}
async function stocked(tenant, qty = 10) {
  run += 1;
  const { productId } = await inv.createProduct({ db, tenant, FieldValue, actor, input: { sku: `R-${run}`, name: `Item ${run}`, unit: "pcs", sellingPrice: 20000, reorderLevel: 0 } });
  await inv.recordMovement({ db, tenant, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(qty), unitCost: 12000, note: "count" } });
  return productId;
}
const create = (tenant, items, customer = { name: "Walk-in" }, extra = {}) => orders.createOrder({ db, tenant, FieldValue, business: BUSINESS, entitlements: ENT, input: { customer, source: "phone", items, ...extra }, idempotencyKey: key(), actor, canDiscount: false, now: NOW });
const product = async (tenant, pid) => {
  const p = (await tenant.doc("products", pid).get()).data();
  return { onHand: p.onHand, reserved: p.reserved, available: p.available };
};
const fulfill = (tenant, orderId) => orders.fulfillOrder({ db, tenant, FieldValue, business: BUSINESS, orderId, actor, now: NOW });
const reopen = (tenant, orderId) => orders.reopenOrder({ db, tenant, FieldValue, business: BUSINESS, orderId, stage: "ready", reason: "Marked by mistake", actor });

describe("reverse a fulfillment (real Firestore)", () => {
  it("fulfil → reverse → fulfil: 10 → 8 → 10 (2 set aside) → 8; the cost record is replaced, its reversal kept", async () => {
    const t = freshTenant();
    const pid = await stocked(t);
    const { orderId } = await create(t, [{ productId: pid, quantity: Q(2) }]);
    await fulfill(t, orderId);
    expect(await product(t, pid)).toEqual({ onHand: Q(8), reserved: 0, available: Q(8) });
    await reopen(t, orderId);
    expect(await product(t, pid)).toEqual({ onHand: Q(10), reserved: Q(2), available: Q(8) });
    expect((await t.doc("orderCosts", orderId).get()).data()).toMatchObject({ reversed: true, reversals: [{ cogs: 24000, to: "ready" }] });
    await fulfill(t, orderId);
    expect(await product(t, pid)).toEqual({ onHand: Q(8), reserved: 0, available: Q(8) });
    const costs = (await t.doc("orderCosts", orderId).get()).data();
    expect(costs.reversed).toBeUndefined();
    expect(costs).toMatchObject({ cogs: 24000, reversals: [{ to: "ready" }] });
    expect((await t.doc("financialMetrics", "2026-10-08").get()).data()).toMatchObject({ grossSales: 40000, cogs: 24000 });
  });

  it("two reversals at once: exactly one reverses, the other is refused; stock comes back once", async () => {
    const t = freshTenant();
    const pid = await stocked(t);
    const { orderId } = await create(t, [{ productId: pid, quantity: Q(3) }]);
    await fulfill(t, orderId);
    const results = await Promise.allSettled([reopen(t, orderId), reopen(t, orderId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(["not-fulfilled", 10]).toContain(r.reason.code);
    expect(await product(t, pid)).toEqual({ onHand: Q(10), reserved: Q(3), available: Q(7) });
  });
});

describe("customers from orders (real Firestore query inside the transaction)", () => {
  it("saved once; same name + same phone → reused; same name only → unlinked; the Owner's 'new' → a second record", async () => {
    const t = freshTenant();
    const pid = await stocked(t, 50);
    const line = [{ productId: pid, quantity: Q(1) }];
    const a = await create(t, line, { name: "Maria Santos", phone: "0917 123 4567" });
    const b = await create(t, line, { name: "MARIA SANTOS", phone: "09171234567" });
    expect(b.customerId).toBe(a.customerId);
    const c = await create(t, line, { name: "Maria Santos" });
    expect((await t.doc("orders", c.orderId).get()).data().customerId).toBeNull();
    const d = await create(t, line, { name: "Maria Santos" }, { newCustomer: true });
    expect(d.customerId).not.toBe(a.customerId);
    const all = (await t.collection("customers").get()).docs.map((x) => x.data());
    expect(all).toHaveLength(2);
    expect(all.find((x) => x.phoneKey === "09171234567").stats).toMatchObject({ orderCount: 2, totalOrdered: 40000 });
  });
});
