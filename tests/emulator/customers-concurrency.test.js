// Customer statistics under concurrency on the REAL Firestore emulator
// (Admin SDK). However orders and payments interleave, a customer's
// stats must equal the sum over its non-cancelled orders, and every
// failure must be explicit (a domain refusal or contention).

import { beforeAll, describe, it, expect, vi } from "vitest";
import { QTY_SCALE } from "../../shared/quantity.js";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
process.env.FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || "demo-luna.appspot.com";
vi.setConfig({ testTimeout: 180000 });

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "conc-cust", name: "Concurrency", email: "" };
const NOW = new Date("2026-10-08T02:00:00Z");
let db, bucket, FieldValue, inv, orders, pay, cust, tenantDb;
let run = 0;
let keySeq = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const admin = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, bucket, admin: { firestore: { FieldValue } } } = await admin.getAdmin());
  inv = await import("../../netlify/functions/_lib/inventory.js");
  orders = await import("../../netlify/functions/_lib/orders.js");
  pay = await import("../../netlify/functions/_lib/payments.js");
  cust = await import("../../netlify/functions/_lib/customers.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
});

const CONTENDED = 10;
const settle = (p) => Promise.allSettled(p);
const ok = (r) => r.filter((x) => x.status === "fulfilled");
function expectExplicit(results, codes = []) {
  for (const r of results) if (r.status === "rejected") expect([CONTENDED, ...codes], String(r.reason && r.reason.message)).toContain(r.reason && r.reason.code);
}
const key = () => `cust-conc-${Date.now().toString(36)}-${++keySeq}`.padEnd(20, "x");

async function world() {
  run += 1;
  const id = `custc-${Date.now().toString(36)}-${run}`;
  const tenant = tenantDb(db, id);
  const business = { id, timezone: "Asia/Manila", orderPrefix: "CU" };
  const { productId } = await inv.createProduct({ db, tenant, FieldValue, actor, input: { sku: `C-${run}`, name: "Item", unit: "pcs", sellingPrice: 10000, reorderLevel: 0 } });
  await inv.recordMovement({ db, tenant, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(1000), unitCost: 5000, note: "count" } });
  const a = await cust.createCustomer({ db, tenant, FieldValue, actor, input: { name: "ABC Store" } });
  const b = await cust.createCustomer({ db, tenant, FieldValue, actor, input: { name: "XYZ Mart" } });
  return { tenant, business, productId, a: a.customerId, b: b.customerId };
}

const create = (w, customerId, qty = 1) =>
  orders.createOrder({ db, tenant: w.tenant, FieldValue, business: w.business, entitlements: { limits: { ordersPerMonth: 1000 } }, input: { customer: { name: "walk-in" }, ...(customerId ? { customerId } : {}), source: "phone", items: [{ productId: w.productId, quantity: Q(qty) }] }, idempotencyKey: key(), actor, canDiscount: false, canLinkCustomers: true, now: NOW });
const edit = (w, orderId, customerId, qty) =>
  orders.updateOrder({ db, tenant: w.tenant, FieldValue, business: w.business, orderId, input: { customer: { name: "walk-in" }, ...(customerId ? { customerId } : {}), source: "phone", items: [{ productId: w.productId, quantity: Q(qty) }] }, actor, canDiscount: false, canLinkCustomers: true });
const record = (w, orderId, amount) => pay.recordPayment({ db, bucket, tenant: w.tenant, FieldValue, business: w.business, orderId, input: { amount, method: "cash" }, actor, canVerify: true, now: NOW });

async function expectConsistent(w, customerId) {
  const c = (await w.tenant.doc("customers", customerId).get()).data();
  const mine = (await w.tenant.collection("orders").where("customerId", "==", customerId).get()).docs.map((d) => d.data()).filter((o) => o.fulfillmentStatus !== "cancelled");
  expect(c.stats.orderCount).toBe(mine.length);
  expect(c.stats.totalOrdered).toBe(mine.reduce((s, o) => s + o.total, 0));
  expect(c.stats.outstandingBalance).toBe(mine.reduce((s, o) => s + o.balance, 0));
  return { c, mine };
}

describe("one customer, many writers", () => {
  it("10 orders for the same customer at once: every one counted exactly once", async () => {
    const w = await world();
    const results = await settle(Array.from({ length: 10 }, (_, i) => create(w, w.a, i + 1)));
    expectExplicit(results);
    const { mine } = await expectConsistent(w, w.a);
    expect(mine).toHaveLength(ok(results).length);
  });

  it("payments, an edit and a new order on the same customer at once", async () => {
    const w = await world();
    const { orderId } = await create(w, w.a, 10); // ₱1,000
    const results = await settle([record(w, orderId, 30000), record(w, orderId, 20000), edit(w, orderId, w.a, 12), create(w, w.a, 3)]);
    expectExplicit(results, ["overpayment", "below-paid"]);
    await expectConsistent(w, w.a);
  });

  it("an order moving between customers while a payment lands: both customers stay exact", async () => {
    const w = await world();
    const { orderId } = await create(w, w.a, 10);
    const results = await settle([edit(w, orderId, w.b, 10), record(w, orderId, 40000)]);
    expectExplicit(results);
    await expectConsistent(w, w.a);
    await expectConsistent(w, w.b);
  });

  it("cancel vs payment on a linked order: exactly one wins and the stats agree", async () => {
    const w = await world();
    const { orderId } = await create(w, w.a, 5);
    const results = await settle([orders.cancelOrder({ db, tenant: w.tenant, FieldValue, business: w.business, orderId, reason: "race test", actor, now: NOW }), record(w, orderId, 10000)]);
    expectExplicit(results, ["order-cancelled", "has-payments"]);
    expect(ok(results)).toHaveLength(1);
    await expectConsistent(w, w.a);
  });
});

describe("customer lifecycle vs orders", () => {
  it("delete a customer vs link a new order to it: never an order pointing at a deleted customer", async () => {
    const w = await world();
    const { customerId } = await cust.createCustomer({ db, tenant: w.tenant, FieldValue, actor, input: { name: "Fresh" } });
    const results = await settle([cust.deleteCustomer({ db, tenant: w.tenant, FieldValue, customerId, actor }), create(w, customerId, 1)]);
    expectExplicit(results, ["customer-not-found", "has-orders"]);
    expect(ok(results)).toHaveLength(1);
    const exists = (await w.tenant.doc("customers", customerId).get()).exists;
    const linked = (await w.tenant.collection("orders").where("customerId", "==", customerId).get()).size;
    if (exists) {
      expect(linked).toBe(1);
      await expectConsistent(w, customerId);
    } else expect(linked).toBe(0);
  });

  it("deactivate vs link: the order exists only if it was linked while active", async () => {
    const w = await world();
    const results = await settle([cust.setCustomerStatus({ db, tenant: w.tenant, FieldValue, customerId: w.b, status: "inactive", actor }), create(w, w.b, 1)]);
    expectExplicit(results, ["customer-inactive"]);
    await expectConsistent(w, w.b);
  });

  it("contact edits racing an order don't disturb the stats", async () => {
    const w = await world();
    const results = await settle([cust.updateCustomer({ db, tenant: w.tenant, FieldValue, customerId: w.a, changes: { phone: "0917 000 1111" }, actor }), create(w, w.a, 2), create(w, w.a, 3)]);
    expectExplicit(results);
    await expectConsistent(w, w.a);
  });
});
