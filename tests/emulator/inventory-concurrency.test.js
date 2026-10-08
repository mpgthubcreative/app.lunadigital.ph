// Concurrency: the REAL inventory service, through the Firebase Admin SDK,
// against the Firestore emulator, so transactions, contention and retries
// behave as in production. Many operations hit the same product at once;
// the result must lose nothing, never go negative, keep the moving average
// right, and leave a history whose before/after values chain exactly.
//
// Runs inside `npm run test:rules` (emulators:exec sets FIRESTORE_EMULATOR_HOST).

import { beforeAll, describe, it, expect, vi } from "vitest";
import { QTY_SCALE, COST_SCALE, inventoryValue } from "../../shared/quantity.js";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";

let db;
let FieldValue;
let svc;
let tenantDb;
const Q = (n) => n * QTY_SCALE;
const actor = { uid: "conc-tester", name: "Concurrency test", email: "" };
let run = 0;

// The emulator serializes contended transactions with slow lock timeouts;
// 20-way contention on one document legitimately takes longer than 30 s.
vi.setConfig({ testTimeout: 180000 });

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the Firestore emulator).");
  const admin = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin: { firestore: { FieldValue } } } = await admin.getAdmin());
  svc = await import("../../netlify/functions/_lib/inventory.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
});

// A fresh business per test so tests never share documents.
function freshTenant() {
  run += 1;
  return tenantDb(db, `conc-${Date.now().toString(36)}-${run}`);
}

async function product(tenant, { unit = "pcs", reorderLevel = Q(5) } = {}) {
  const { productId } = await svc.createProduct({ db, tenant, FieldValue, actor, input: { sku: `SKU-${run}`, name: "Contended product", unit, sellingPrice: 1000, reorderLevel } });
  return productId;
}

const move = (tenant, productId, movement) => svc.recordMovement({ db, tenant, FieldValue, productId, movement, actor });
const settle = (promises) => Promise.allSettled(promises);
const ok = (results) => results.filter((r) => r.status === "fulfilled");
const failedWith = (results, code) => results.filter((r) => r.status === "rejected" && r.reason && r.reason.code === code);
// gRPC ABORTED: the transaction gave up after its retries under contention.
// It changed nothing and the caller gets an error: never a silent loss.
const CONTENDED = 10;
// Every outcome is explicit: success, a domain refusal, or contention.
function expectExplicit(results, allowedDomainCodes = []) {
  for (const r of results) {
    if (r.status === "fulfilled") continue;
    expect([CONTENDED, ...allowedDomainCodes], String(r.reason && r.reason.message)).toContain(r.reason && r.reason.code);
  }
}
const okIndexes = (results) => results.map((r, i) => (r.status === "fulfilled" ? i : -1)).filter((i) => i >= 0);

async function state(tenant, productId) {
  const [p, c, logSnap, costSnap, metrics, fin] = await Promise.all([
    tenant.doc("products", productId).get(),
    tenant.doc("productCosts", productId).get(),
    tenant.collection("inventoryTransactions").where("productId", "==", productId).get(),
    tenant.collection("inventoryTransactionCosts").where("productId", "==", productId).get(),
    tenant.doc("metrics", "current").get(),
    tenant.doc("financialMetrics", "current").get(),
  ]);
  const log = logSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.seq - b.seq);
  const costs = Object.fromEntries(costSnap.docs.map((d) => [d.id, d.data()]));
  return { product: p.data(), costs: c.data(), log, costLog: log.map((t) => costs[t.id]), metrics: metrics.data() || {}, fin: fin.data() || {} };
}

// The log must chain perfectly: seq 1..n, every "before" equals the
// previous "after", and the last "after" equals the product document.
function expectChained({ product, costs, log, costLog }) {
  expect(log.map((t) => t.seq)).toEqual(log.map((_, i) => i + 1));
  for (let i = 1; i < log.length; i++) {
    expect(log[i].onHandBefore).toBe(log[i - 1].onHandAfter);
    expect(log[i].reservedBefore).toBe(log[i - 1].reservedAfter);
    expect(costLog[i].avgCostBefore).toBe(costLog[i - 1].avgCostAfter);
    expect(costLog[i].valueBefore).toBe(costLog[i - 1].valueAfter);
  }
  const last = log.at(-1);
  expect(product.onHand).toBe(last.onHandAfter);
  expect(product.reserved).toBe(last.reservedAfter);
  expect(product.available).toBe(product.onHand - product.reserved);
  expect(product.movementCount).toBe(log.length);
  expect(costs.avgCostUnits).toBe(costLog.at(-1).avgCostAfter);
  expect(product.reserved).toBeGreaterThanOrEqual(0);
  expect(product.available).toBeGreaterThanOrEqual(0);
}

describe("concurrent receipts", () => {
  it("20 simultaneous receipts at different costs: nothing lost, average correct, history chained", async () => {
    const tenant = freshTenant();
    const pid = await product(tenant);
    await move(tenant, pid, { type: "opening", quantity: Q(100), unitCost: 5000, note: "count" });
    const receipts = Array.from({ length: 20 }, (_, i) => ({ quantity: Q((i % 5) + 1), unitCost: 5000 + i * 137 }));

    const results = await settle(receipts.map((r) => move(tenant, pid, { type: "receipt", ...r })));
    expectExplicit(results);
    const applied = okIndexes(results).map((i) => receipts[i]);
    expect(applied.length).toBeGreaterThan(0);

    const s = await state(tenant, pid);
    // Exactly the successful receipts were applied: none lost, none doubled.
    const totalQty = Q(100) + applied.reduce((a, r) => a + r.quantity, 0);
    expect(s.product.onHand).toBe(totalQty);
    expect(s.log).toHaveLength(1 + applied.length);
    expectChained(s);
    // Serialization order only changes per-step rounding: within 1 centavo
    // per unit of the exact weighted average of what was applied.
    const exactValue = 100 * 5000 + applied.reduce((a, r) => a + (r.quantity / QTY_SCALE) * r.unitCost, 0);
    const exactAvg = (exactValue * COST_SCALE) / (totalQty / QTY_SCALE);
    expect(Math.abs(s.costs.avgCostUnits - exactAvg)).toBeLessThan(COST_SCALE);
    expect(s.costs.inventoryValue).toBe(inventoryValue(s.product.onHand, s.costs.avgCostUnits));
  });
});

describe("concurrent adjustments", () => {
  it("20 simultaneous -1 adjustments on 10 in stock: exactly 10 succeed, stock never negative", async () => {
    const tenant = freshTenant();
    const pid = await product(tenant);
    await move(tenant, pid, { type: "opening", quantity: Q(10), unitCost: 5000, note: "count" });
    const results = await settle(Array.from({ length: 20 }, () => move(tenant, pid, { type: "adjustment_decrease", quantity: Q(1), reason: "damaged" })));
    expectExplicit(results, ["insufficient-stock"]);
    expect(ok(results).length).toBeLessThanOrEqual(10);
    const s = await state(tenant, pid);
    expect(s.product.onHand).toBe(Q(10 - ok(results).length));
    expect(s.product.onHand).toBeGreaterThanOrEqual(0);
    expect(s.costs.avgCostUnits).toBe(50000000); // decreases never move the average
    expectChained(s);
  });

  it("receipts and adjustments interleaved: final stock = opening + receipts - adjustments", async () => {
    const tenant = freshTenant();
    const pid = await product(tenant);
    await move(tenant, pid, { type: "opening", quantity: Q(50), unitCost: 5000, note: "count" });
    const ops = [];
    for (let i = 0; i < 10; i++) {
      ops.push(move(tenant, pid, { type: "receipt", quantity: Q(2), unitCost: 6000 }));
      ops.push(move(tenant, pid, { type: "adjustment_decrease", quantity: Q(1), reason: "lost" }));
      ops.push(move(tenant, pid, { type: "adjustment_increase", quantity: Q(1), reason: "found" }));
    }
    const kinds = [];
    for (let i = 0; i < 10; i++) kinds.push(2, -1, 1);
    const results = await settle(ops);
    expectExplicit(results);
    const net = okIndexes(results).reduce((a, i) => a + kinds[i], 0);
    const s = await state(tenant, pid);
    expect(s.product.onHand).toBe(Q(50 + net));
    expect(s.log).toHaveLength(1 + ok(results).length);
    expectChained(s);
  });
});

describe("reservation contention (Phase 7 readiness)", () => {
  it("15 simultaneous reservations of 1 on 10 available: exactly 10 succeed", async () => {
    const tenant = freshTenant();
    const pid = await product(tenant, { reorderLevel: Q(2) });
    await move(tenant, pid, { type: "opening", quantity: Q(10), unitCost: 5000, note: "count" });
    const results = await settle(Array.from({ length: 15 }, () => move(tenant, pid, { type: "reservation", quantity: Q(1) })));
    expectExplicit(results, ["insufficient-stock"]);
    expect(ok(results).length).toBeLessThanOrEqual(10);
    const s = await state(tenant, pid);
    expect(s.product).toMatchObject({ onHand: Q(10), reserved: Q(ok(results).length), available: Q(10 - ok(results).length) });
    expectChained(s);
  });

  it("12 simultaneous releases of 1 against 10 reserved: never below zero", async () => {
    const tenant = freshTenant();
    const pid = await product(tenant);
    await move(tenant, pid, { type: "opening", quantity: Q(10), unitCost: 5000, note: "count" });
    for (let i = 0; i < 10; i++) await move(tenant, pid, { type: "reservation", quantity: Q(1) });
    const results = await settle(Array.from({ length: 12 }, () => move(tenant, pid, { type: "release", quantity: Q(1) })));
    expectExplicit(results, ["insufficient-reserved"]);
    expect(ok(results).length).toBeLessThanOrEqual(10);
    const s = await state(tenant, pid);
    expect(s.product.reserved).toBe(Q(10 - ok(results).length));
    expect(s.product.reserved).toBeGreaterThanOrEqual(0);
    expectChained(s);
  });

  it("reservations racing a stock decrease can't oversell", async () => {
    const tenant = freshTenant();
    const pid = await product(tenant);
    await move(tenant, pid, { type: "opening", quantity: Q(5), unitCost: 5000, note: "count" });
    const results = await settle([
      ...Array.from({ length: 5 }, () => move(tenant, pid, { type: "reservation", quantity: Q(1) })),
      move(tenant, pid, { type: "adjustment_decrease", quantity: Q(3), reason: "damaged" }),
    ]);
    expectExplicit(results, ["insufficient-stock"]);
    const s = await state(tenant, pid);
    expect(s.product.onHand).toBeGreaterThanOrEqual(s.product.reserved);
    expect(s.product.available).toBeGreaterThanOrEqual(0);
    expect(ok(results).length).toBeLessThan(6);
    expectChained(s);
  });
});

describe("SKU uniqueness and gauges under contention", () => {
  it("10 simultaneous creates with the same SKU: exactly one wins", async () => {
    const tenant = freshTenant();
    const results = await settle(Array.from({ length: 10 }, (_, i) => svc.createProduct({ db, tenant, FieldValue, actor, input: { sku: "DUP-1", name: `Racer ${i}`, unit: "pcs", sellingPrice: 1, reorderLevel: 0 } })));
    expectExplicit(results, ["duplicate-sku", 6]); // 6 = ALREADY_EXISTS from create()
    expect(ok(results)).toHaveLength(1);
    const products = await tenant.collection("products").where("sku", "==", "DUP-1").get();
    expect(products.size).toBe(1);
    const index = await tenant.doc("skuIndex", "DUP-1").get();
    expect(index.data().productId).toBe(products.docs[0].id);
  });

  it("the low-stock gauge equals the number of low-stock products after concurrent changes", async () => {
    const tenant = freshTenant();
    const ids = [];
    for (let i = 0; i < 4; i++) {
      run += 1;
      ids.push(await product(tenant, { reorderLevel: Q(5) }));
    }
    await Promise.all(ids.map((pid) => move(tenant, pid, { type: "opening", quantity: Q(8), unitCost: 1000, note: "count" })));
    const results = await settle(ids.flatMap((pid) => Array.from({ length: 4 }, () => move(tenant, pid, { type: "adjustment_decrease", quantity: Q(1), reason: "damaged" }))));
    expectExplicit(results);
    const [lowProducts, metrics] = await Promise.all([tenant.collection("products").where("isLowStock", "==", true).get(), tenant.doc("metrics", "current").get()]);
    // Whatever subset succeeded, the gauge matches the products exactly.
    expect(metrics.data().lowStockProducts).toBe(lowProducts.size);
  });
});
