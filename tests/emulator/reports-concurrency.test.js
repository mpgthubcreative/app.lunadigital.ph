// Report rollups on the REAL Firestore emulator (Admin SDK): nested-map
// merges with increments behave as in production, and under concurrent
// fulfilments, corrections, payments and expenses the incrementally kept
// rollups equal a rebuild from the source records.

import { beforeAll, describe, it, expect, vi } from "vitest";
import { QTY_SCALE } from "../../shared/quantity.js";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
process.env.FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || "demo-luna.appspot.com";
vi.setConfig({ testTimeout: 180000 });

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "conc-rep", name: "Concurrency", email: "" };
const NOW = new Date("2026-10-08T06:00:00Z");
let db, bucket, FieldValue, inv, orders, pay, ex, cust, rep, tenantDb;
let run = 0;
let keySeq = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const admin = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, bucket, admin: { firestore: { FieldValue } } } = await admin.getAdmin());
  inv = await import("../../netlify/functions/_lib/inventory.js");
  orders = await import("../../netlify/functions/_lib/orders.js");
  pay = await import("../../netlify/functions/_lib/payments.js");
  ex = await import("../../netlify/functions/_lib/expenses.js");
  cust = await import("../../netlify/functions/_lib/customers.js");
  rep = await import("../../netlify/functions/_lib/reports.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
});

const CONTENDED = 10;
const settle = (p) => Promise.allSettled(p);
function expectExplicit(results, codes = []) {
  for (const r of results) if (r.status === "rejected") expect([CONTENDED, ...codes], String(r.reason && r.reason.message)).toContain(r.reason && r.reason.code);
}

async function world() {
  run += 1;
  const id = `repc-${Date.now().toString(36)}-${run}`;
  const tenant = tenantDb(db, id);
  const business = { id, timezone: "Asia/Manila", orderPrefix: "RP" };
  const products = [];
  for (const [price, cost] of [[100000, 60000], [33333, 12345]]) {
    const { productId } = await inv.createProduct({ db, tenant, FieldValue, actor, input: { sku: `RP-${run}-${products.length}`, name: `Item ${products.length}`, unit: "pcs", sellingPrice: price, reorderLevel: 0 } });
    await inv.recordMovement({ db, tenant, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(500), unitCost: cost, note: "count" } });
    products.push(productId);
  }
  const c = (await cust.createCustomer({ db, tenant, FieldValue, actor, input: { name: "ABC" } })).customerId;
  return { tenant, business, products, customerId: c };
}
const create = (w, productId, qty, customerId = null, discount = 0) =>
  orders.createOrder({ db, tenant: w.tenant, FieldValue, business: w.business, entitlements: { limits: { ordersPerMonth: 1000 } }, input: { customer: { name: "walk-in" }, ...(customerId ? { customerId } : {}), source: "phone", items: [{ productId, quantity: Q(qty) }], discount }, idempotencyKey: `rep-conc-${Date.now().toString(36)}-${++keySeq}`.padEnd(20, "x"), actor, canDiscount: true, canLinkCustomers: true, now: NOW });
const fulfil = (w, orderId) => orders.fulfillOrder({ db, tenant: w.tenant, FieldValue, business: w.business, orderId, actor, now: NOW });
const record = (w, orderId, amount, method) => pay.recordPayment({ db, bucket, tenant: w.tenant, FieldValue, business: w.business, orderId, input: { amount, method, ...(method === "cash" ? {} : { reference: `R${++keySeq}X${run}Z` }) }, actor, canVerify: true, now: NOW });
const spend = (w, date, amount, category, method) => ex.createExpense({ db, tenant: w.tenant, FieldValue, business: w.business, workspace: "distributor", actor, now: NOW, input: { date, category, amount, method } });

const numeric = (r) => {
  const out = {};
  for (const s of ["products", "customers", "paymentMethods", "expenseCategories", "expenseMethods"]) {
    for (const [k, v] of Object.entries((r && r[s]) || {})) {
      const nums = Object.fromEntries(Object.entries(v).filter(([f, x]) => typeof x === "number" && !["sku", "name", "unit"].includes(f)));
      if (Object.values(nums).some((x) => x !== 0)) (out[s] ||= {})[k] = nums;
    }
  }
  return out;
};
async function expectRollupsMatchSource(w) {
  const fresh = await rep.computeRollupsFromSource({ tenant: w.tenant });
  const stored = new Map((await w.tenant.collection("reportRollups").get()).docs.map((d) => [d.id, d.data()]));
  for (const id of new Set([...fresh.keys(), ...stored.keys()])) expect(numeric(stored.get(id)), id).toEqual(numeric(fresh.get(id)));
  return stored;
}

describe("rollups under concurrency (real emulator)", () => {
  it("nested-map increments merge per key (no product overwrites another)", async () => {
    const w = await world();
    const a = (await create(w, w.products[0], 2)).orderId;
    const b = (await create(w, w.products[1], 3)).orderId;
    await fulfil(w, a);
    await fulfil(w, b);
    const stored = await expectRollupsMatchSource(w);
    expect(Object.keys(stored.get("2026-10-08").products).sort()).toEqual([...w.products].sort());
  });

  it("10 fulfilments at once, mixed products, customers and discounts", async () => {
    const w = await world();
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push((await create(w, w.products[i % 2], i + 1, i % 3 ? w.customerId : null, i * 7)).orderId);
    expectExplicit(await settle(ids.map((id) => fulfil(w, id))));
    await expectRollupsMatchSource(w);
  });

  it("corrections, payments (with edits and voids) and expenses racing on the same day", async () => {
    const w = await world();
    const o1 = (await create(w, w.products[0], 10, w.customerId)).orderId;
    const o2 = (await create(w, w.products[1], 5)).orderId;
    await fulfil(w, o1);
    await fulfil(w, o2);
    const p1 = (await record(w, o1, 100000, "gcash")).paymentId;
    const e1 = (await spend(w, "2026-10-08", 5000, "packaging", "cash")).expenseId;
    const results = await settle([
      orders.updateOrder({ db, tenant: w.tenant, FieldValue, business: w.business, orderId: o1, input: { customer: {}, customerId: w.customerId, source: "phone", items: [{ productId: w.products[0], quantity: Q(8) }, { productId: w.products[1], quantity: Q(2) }] }, actor, canDiscount: true, canLinkCustomers: true, canCorrect: true, reason: "corrected lines" }),
      pay.updatePayment({ db, bucket, tenant: w.tenant, FieldValue, business: w.business, paymentId: p1, changes: { method: "maya", amount: 90000 }, actor }),
      record(w, o2, 20000, "cash"),
      record(w, o2, 30000, "bank_transfer"),
      ex.updateExpense({ db, tenant: w.tenant, FieldValue, business: w.business, workspace: "distributor", actor, now: NOW, expenseId: e1, changes: { category: "fees", date: "2026-10-01" } }),
      spend(w, "2026-10-08", 7000, "rent", "gcash"),
    ]);
    expectExplicit(results, ["overpayment", "below-paid"]);
    await expectRollupsMatchSource(w);
    // Breakdowns still sum to the metric documents.
    const day = (await w.tenant.doc("financialMetrics", "2026-10-08").get()).data();
    const r = (await w.tenant.doc("reportRollups", "2026-10-08").get()).data();
    const sum = (m, f) => Object.values(m || {}).reduce((s, v) => s + (v[f] || 0), 0);
    expect(sum(r.products, "netSales")).toBe(day.grossSales - day.discounts - day.returns);
    expect(sum(r.products, "cogs")).toBe(day.cogs);
    expect(sum(r.paymentMethods, "amount")).toBe(day.paymentsReceived);
    expect(sum(r.expenseCategories, "amount")).toBe(day.operatingExpenses);
  });

  it("rebuild on the emulator writes the same documents (and removes stale ones)", async () => {
    const w = await world();
    const o = (await create(w, w.products[0], 4, w.customerId)).orderId;
    await fulfil(w, o);
    await w.tenant.doc("reportRollups", "2026-01-01").set({ period: "day", id: "2026-01-01", products: { ghost: { qty: 1, netSales: 1, cogs: 1 } } });
    const before = await expectRollupsMatchSource(w).catch(() => null);
    expect(before).toBeNull(); // the ghost doc doesn't match the source
    const r = await rep.rebuildRollups({ db, tenant: w.tenant, FieldValue });
    expect(r.removed).toBe(1);
    await expectRollupsMatchSource(w);
  });
});
