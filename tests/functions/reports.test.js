// Phase 11: Distributor Reports on the server. The required scenario,
// Dashboard-vs-Reports consistency, Sales vs Payments, historical
// restatement, rollups (incremental == rebuilt from source, and summing to
// the metric totals), financial / module permission shapes, and tenant /
// workspace isolation.

import { describe, it, expect, beforeEach } from "vitest";
import { createOrder, fulfillOrder, updateOrder, cancelOrder } from "../../netlify/functions/_lib/orders.js";
import { recordPayment, updatePayment, voidPayment } from "../../netlify/functions/_lib/payments.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createCustomer } from "../../netlify/functions/_lib/customers.js";
import { createExpense, updateExpense, removeExpense } from "../../netlify/functions/_lib/expenses.js";
import { computeRollupsFromSource, rebuildRollups } from "../../netlify/functions/_lib/reports.js";
import { createReportsHandler } from "../../netlify/functions/reports.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { financialSummary } from "../../shared/finance.js";
import { WALK_IN_KEY } from "../../shared/reports.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-carlo", name: "Carlo", email: "c@t.test" };
const BIZ = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" };
const OCT8 = new Date("2026-10-08T06:00:00Z"); // 14:00 Manila
const OCT1 = new Date("2026-10-01T06:00:00Z");
let world;
let A;
let k = 0;

beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});

const docAt = (p) => world.db.docs.get(p);
const common = (now = OCT8) => ({ db: world.db, tenant: A, FieldValue, business: BIZ, workspace: "distributor", actor, now });
async function product(price, cost, qty = 100) {
  const { productId } = await createProduct({ ...common(), input: { sku: `R-${++k}`, name: `Item ${k}`, unit: "pcs", sellingPrice: price, reorderLevel: 0 } });
  await recordMovement({ ...common(), productId, movement: { type: "opening", quantity: Q(qty), unitCost: cost, note: "count" } });
  return productId;
}
async function sale({ productId, qty, customerId = null, now = OCT8, fulfill = true, discount = 0 }) {
  const { orderId } = await createOrder({ ...common(now), entitlements: docAt("businesses/biz-a").entitlements, input: { customer: { name: "Walk-in" }, ...(customerId ? { customerId } : {}), source: "phone", items: [{ productId, quantity: Q(qty) }], discount }, idempotencyKey: `rep-key-${String(++k).padStart(12, "0")}`, canDiscount: true, canLinkCustomers: true });
  if (fulfill) await fulfillOrder({ ...common(now), orderId });
  return orderId;
}
const pay = (orderId, amount, method = "cash", now = OCT8) => recordPayment({ ...common(now), bucket: world.bucket, orderId, input: { amount, method, ...(method === "gcash" ? { reference: `G${++k}XYZ1` } : {}) }, canVerify: true });
const spend = (date, amount, category = "packaging", method = "cash") => createExpense({ ...common(), input: { date, category, amount, method } });

const handler = () => createReportsHandler({ getAdmin: async () => world, now: () => OCT8 });
async function report(uid, from, to, businessId, extra = {}) {
  const res = await handler()({ ...request({ uid, businessId }), queryStringParameters: { from, to, ...extra } });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

// The rollups maintained incrementally must equal a rebuild from source.
async function expectRollupsMatchSource() {
  const fresh = await computeRollupsFromSource({ tenant: A });
  const stored = new Map([...world.db.docs.entries()].filter(([p]) => p.startsWith("businesses/biz-a/reportRollups/")).map(([p, d]) => [p.split("/").at(-1), d]));
  const strip = (r) => {
    const out = {};
    for (const s of ["products", "customers", "paymentMethods", "expenseCategories", "expenseMethods"]) {
      for (const [key, v] of Object.entries((r && r[s]) || {})) {
        const nums = Object.fromEntries(Object.entries(v).filter(([f, x]) => typeof x === "number" && !["sku", "name", "unit"].includes(f)));
        if (Object.values(nums).some((x) => x !== 0)) (out[s] ||= {})[key] = nums;
      }
    }
    return out;
  };
  for (const id of new Set([...fresh.keys(), ...stored.keys()])) expect(strip(stored.get(id)), id).toEqual(strip(fresh.get(id)));
}

describe("THE scenario: two fulfilled orders, ₱1,500 expense, ₱12,000 collected", () => {
  it("returns exactly the expected figures, and matches the Dashboard's documents", async () => {
    const p1 = await product(100000, 60000); // ₱1,000 / ₱600 cost
    const p2 = await product(50000, 30000); // ₱500 / ₱300 cost
    const { customerId } = await createCustomer({ ...common(), input: { name: "ABC Store" } });
    const o1 = await sale({ productId: p1, qty: 10, customerId }); // ₱10,000 / ₱6,000
    const o2 = await sale({ productId: p2, qty: 10 }); // ₱5,000 / ₱3,000, walk-in
    await spend("2026-10-08", 150000);
    await pay(o1, 1000000, "gcash");
    await pay(o2, 200000, "cash");

    const r = await report(world.uids.ownera, "2026-10-08", "2026-10-08");
    expect(r.status).toBe(200);
    expect(r.body.overview).toMatchObject({
      netSales: 1500000, cogs: 900000, grossProfit: 600000, grossMarginPct: 40, operatingExpenses: 150000, estimatedOperatingProfit: 450000,
      paymentsReceived: 1200000, ordersCreated: 2, fulfilledOrders: 2, cancelledOrders: 0, averageOrderValue: 750000,
    });
    expect(r.body.payments).toMatchObject({ unpaidBalanceNow: 300000, unpaidOrdersNow: 1, methods: [{ method: "gcash", count: 1, amount: 1000000 }, { method: "cash", count: 1, amount: 200000 }] });
    expect(r.body.products.rows.map((p) => [p.productId, p.qty, p.netSales, p.cogs, p.grossProfit])).toEqual([[p1, Q(10), 1000000, 600000, 400000], [p2, Q(10), 500000, 300000, 200000]]);
    expect(r.body.customers.rows).toEqual([
      { customerId, walkIn: false, name: "ABC Store", orders: 1, netSales: 1000000, outstandingBalanceNow: 0, lastOrderNumber: expect.any(String) },
      { customerId: null, walkIn: true, name: null, orders: 1, netSales: 500000, outstandingBalanceNow: null, lastOrderNumber: null },
    ]);
    expect(r.body.expenses.categories).toEqual([{ key: "packaging", count: 1, amount: 150000 }]);

    // Dashboard reads financialMetrics/{day} through the same financialSummary.
    const dash = financialSummary(docAt("businesses/biz-a/financialMetrics/2026-10-08"));
    for (const f of ["netSales", "cogs", "grossProfit", "operatingExpenses", "estimatedOperatingProfit", "paymentsReceived"]) expect(r.body.overview[f], f).toBe(dash[f]);
    expect(r.body.payments.unpaidBalanceNow).toBe(docAt("businesses/biz-a/financialMetrics/current").receivablesOutstanding);
    // Month range = same totals (only Oct 8 had activity).
    const m = await report(world.uids.ownera, "2026-10-01", "2026-10-08");
    expect(m.body.overview).toMatchObject({ netSales: 1500000, estimatedOperatingProfit: 450000, paymentsReceived: 1200000 });
    await expectRollupsMatchSource();
  });
});

describe("Sales vs Payments (Phase 7 recognition)", () => {
  it("payment before fulfilment: Payments Received only; fulfilment later: Sales on that later day", async () => {
    const p = await product(100000, 60000);
    const orderId = await sale({ productId: p, qty: 2, now: OCT1, fulfill: false });
    await pay(orderId, 200000, "cash", OCT1);
    let r = await report(world.uids.ownera, "2026-10-01", "2026-10-01");
    expect(r.body.overview).toMatchObject({ paymentsReceived: 200000, netSales: 0, cogs: 0, fulfilledOrders: 0, ordersCreated: 1 });
    expect(r.body.products.rows).toEqual([]);
    await fulfillOrder({ ...common(OCT8), orderId });
    r = await report(world.uids.ownera, "2026-10-08", "2026-10-08");
    expect(r.body.overview).toMatchObject({ netSales: 200000, paymentsReceived: 0, fulfilledOrders: 1 });
    expect(r.body.products.rows[0]).toMatchObject({ qty: Q(2), netSales: 200000 });
  });
});

describe("historical corrections restate the original period", () => {
  it("a fulfilled-order correction, a back-dated expense and a voided payment land on their own days", async () => {
    const p = await product(100000, 60000);
    const orderId = await sale({ productId: p, qty: 10, now: OCT1 });
    const pid = (await pay(orderId, 300000, "gcash", OCT1)).paymentId;
    // Today (Oct 8): correct Oct 1's order 10 -> 8, record a Sept expense, void Oct 1's payment.
    await updateOrder({ ...common(OCT8), orderId, input: { customer: { name: "Walk-in" }, source: "phone", items: [{ productId: p, quantity: Q(8) }] }, canDiscount: false, canCorrect: true, reason: "Customer took 8" });
    await spend("2026-09-30", 250000, "rent", "bank_transfer");
    await voidPayment({ ...common(OCT8), paymentId: pid, reason: "entered on wrong order" });

    const oct1 = await report(world.uids.ownera, "2026-10-01", "2026-10-01");
    expect(oct1.body.overview).toMatchObject({ netSales: 800000, cogs: 480000, grossProfit: 320000, paymentsReceived: 0 });
    expect(oct1.body.products.rows[0]).toMatchObject({ qty: Q(8), netSales: 800000, cogs: 480000 });
    expect(oct1.body.payments.methods).toEqual([]);
    const sep30 = await report(world.uids.ownera, "2026-09-30", "2026-09-30");
    expect(sep30.body.overview).toMatchObject({ operatingExpenses: 250000 });
    expect(sep30.body.expenses.categories).toEqual([{ key: "rent", count: 1, amount: 250000 }]);
    const oct8 = await report(world.uids.ownera, "2026-10-08", "2026-10-08");
    expect(oct8.body.overview.netSales ?? 0).toBe(0);
    await expectRollupsMatchSource();
  });
});

describe("rollups stay exact through every kind of change", () => {
  it("mixed sequence: discounts, customer moves, corrections, cancels, payment edits / voids, expense edits / removes", async () => {
    const p1 = await product(100000, 60000);
    const p2 = await product(33333, 12345);
    const a = (await createCustomer({ ...common(), input: { name: "A Store" } })).customerId;
    const b = (await createCustomer({ ...common(), input: { name: "B Store" } })).customerId;
    const o1 = await sale({ productId: p1, qty: 3, customerId: a, discount: 1001 });
    const o2 = await sale({ productId: p2, qty: 7, customerId: b, now: OCT1 });
    const o3 = await sale({ productId: p2, qty: 1, fulfill: false });
    await updateOrder({ ...common(), orderId: o1, input: { customer: {}, customerId: b, source: "phone", items: [{ productId: p1, quantity: Q(2) }, { productId: p2, quantity: Q(4) }], discount: 999 }, canDiscount: true, canLinkCustomers: true, canCorrect: true, reason: "fix lines" });
    await cancelOrder({ ...common(), orderId: o3, reason: "no stock" });
    const x = await pay(o2, 50000, "gcash");
    await updatePayment({ ...common(), bucket: world.bucket, paymentId: x.paymentId, changes: { method: "maya", amount: 60000 } });
    const y = await pay(o1, 1000, "cash");
    await voidPayment({ ...common(), paymentId: y.paymentId, reason: "duplicate" });
    const e1 = await spend("2026-10-08", 1000, "packaging", "cash");
    const e2 = await spend("2026-10-02", 2000, "fees", "card");
    await updateExpense({ ...common(), expenseId: e1.expenseId, changes: { category: "supplies", date: "2026-09-15", method: "gcash", amount: 1500 } });
    await removeExpense({ ...common(), expenseId: e2.expenseId, reason: "typo" });
    await expectRollupsMatchSource();

    // Breakdowns add up to the metric totals for any range.
    const r = await report(world.uids.ownera, "2026-09-01", "2026-10-08");
    const sum = (rows, f) => rows.reduce((s, x) => s + x[f], 0);
    expect(sum(r.body.products.rows, "netSales")).toBe(r.body.overview.netSales);
    expect(sum(r.body.products.rows, "cogs")).toBe(r.body.overview.cogs);
    expect(sum(r.body.customers.rows, "netSales")).toBe(r.body.overview.netSales);
    expect(sum(r.body.customers.rows, "orders")).toBe(r.body.overview.fulfilledOrders);
    expect(sum(r.body.payments.methods, "amount")).toBe(r.body.overview.paymentsReceived);
    expect(sum(r.body.expenses.categories, "amount")).toBe(r.body.overview.operatingExpenses);
    expect(r.body.payments.methods.map((m) => m.method)).toEqual(["maya"]);
    expect(r.body.expenses.categories).toEqual([{ key: "supplies", count: 1, amount: 1500 }]);

    // The rebuild script produces the same documents.
    await rebuildRollups({ db: world.db, tenant: A, FieldValue });
    await expectRollupsMatchSource();
    expect((await report(world.uids.ownera, "2026-09-01", "2026-10-08")).body).toEqual(r.body);
  });

  it("long ranges (monthly buckets) total the same as the sum of their days", async () => {
    const p = await product(100000, 60000);
    await sale({ productId: p, qty: 1, now: new Date("2026-07-20T06:00:00Z") });
    await sale({ productId: p, qty: 2, now: OCT1 });
    await spend("2026-08-05", 7000);
    const long = await report(world.uids.ownera, "2026-07-15", "2026-10-08");
    expect(long.body.range.granularity).toBe("month");
    expect(long.body.series.map((s) => s.period)).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(long.body.overview).toMatchObject({ netSales: 300000, operatingExpenses: 7000, fulfilledOrders: 2 });
    expect(long.body.series.map((s) => s.netSales)).toEqual([100000, 0, null, 200000]);
    // Phase 18.5: COGS per period for the charts; gross profit = net sales − COGS.
    for (const s of long.body.series) if (s.netSales !== null) expect(s.grossProfit).toBe(s.netSales - s.cogs);
    expect(long.body.series.map((s) => s.cogs)).toEqual([60000, 0, null, 120000]);
  });
});

describe("no data vs real zero", () => {
  it("a period with no activity is null (No data), never a fabricated ₱0", async () => {
    const r = await report(world.uids.ownera, "2026-10-08", "2026-10-08");
    expect(r.body.overview).toMatchObject({ netSales: null, operatingExpenses: null, ordersCreated: null, grossMarginPct: null });
    expect(r.body.products.rows).toBeNull();
  });
});

describe("financial and module permissions are enforced by the SERVER", () => {
  const MONEY = /"(netSales|grossSales|discounts|returns|cogs|grossProfit|grossMarginPct|operatingExpenses|estimatedOperatingProfit|paymentsReceived|averageOrderValue|amount|unpaidBalanceNow|outstandingBalanceNow)"/;

  it("staff granted reports.view only: counts and quantities, no money anywhere, no Expenses section", async () => {
    const p = await product(100000, 60000);
    const o = await sale({ productId: p, qty: 3 });
    await pay(o, 100000, "gcash");
    await spend("2026-10-08", 5000);
    const u = await ensureAuthUser({ auth: world.auth, email: "rs@t.test", name: "Report Staff" });
    await addMember({ ...world, businessId: "biz-a", uid: u.uid, email: u.email, name: "Report Staff", roleTemplate: "staff", permissionOverrides: { grant: ["reports.view"] } });
    const r = await report(u.uid, "2026-10-08", "2026-10-08");
    expect(r.status).toBe(200);
    expect(r.body.access.financials).toBe(false);
    for (const row of r.body.series) expect(row).not.toHaveProperty("cogs");
    expect(JSON.stringify(r.body)).not.toMatch(MONEY);
    expect(r.body.overview).toEqual({ ordersCreated: 1, fulfilledOrders: 1, cancelledOrders: 0 });
    expect(r.body.products.rows).toEqual([expect.objectContaining({ productId: p, qty: Q(3) })]);
    expect(r.body.payments.methods).toEqual([{ method: "gcash", count: 1 }]);
    expect(r.body.sections).toEqual(["payments", "products", "customers", "inventory"]);
    expect(r.body.expenses).toBeUndefined();
  });

  it("a section disappears when its module's view permission is revoked", async () => {
    const u = await ensureAuthUser({ auth: world.auth, email: "mgr2@t.test", name: "Mgr" });
    await addMember({ ...world, businessId: "biz-a", uid: u.uid, email: u.email, name: "Mgr", roleTemplate: "manager", permissionOverrides: { revoke: ["customers.view", "payments.view"] } });
    const r = await report(u.uid, "2026-10-08", "2026-10-08");
    expect(r.body.sections).toEqual(["products", "expenses", "inventory"]);
    expect(r.body.customers).toBeUndefined();
    expect(r.body.payments).toBeUndefined();
  });

  it("staff without reports.view: 403", async () => {
    expect((await report(world.uids.staffa, "2026-10-08", "2026-10-08")).status).toBe(403);
  });
});

describe("range validation and isolation", () => {
  it("bad, future, reversed or too-long ranges, and unknown parameters are refused", async () => {
    for (const [from, to] of [["2026-10-09", "2026-10-09"], ["2026-10-08", "2026-10-01"], ["2025-10-07", "2026-10-08"], ["x", "2026-10-08"], [undefined, undefined]]) {
      expect((await report(world.uids.ownera, from, to)).status, `${from}..${to}`).toBe(400);
    }
    for (const extra of [{ businessId: "biz-b" }, { cursor: "abc" }, { section: "all" }]) expect((await report(world.uids.ownera, "2026-10-08", "2026-10-08", undefined, extra)).status).toBe(400);
  });

  it("Business A can never get Business B's totals", async () => {
    const B = tenantDb(world.db, "biz-b");
    const { productId } = await createProduct({ db: world.db, tenant: B, FieldValue, actor, input: { sku: "B1", name: "B", unit: "pcs", sellingPrice: 999900, reorderLevel: 0 } });
    await recordMovement({ db: world.db, tenant: B, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(5), unitCost: 100, note: "x" } });
    const { orderId } = await createOrder({ db: world.db, tenant: B, FieldValue, business: { ...BIZ, id: "biz-b" }, entitlements: docAt("businesses/biz-b").entitlements, input: { customer: { name: "B" }, source: "phone", items: [{ productId, quantity: Q(1) }] }, idempotencyKey: "rep-b-key-000000000001", actor, canDiscount: false, now: OCT8 });
    await fulfillOrder({ db: world.db, tenant: B, FieldValue, business: { ...BIZ, id: "biz-b" }, orderId, actor, now: OCT8 });
    for (const uid of [world.uids.ownera, world.uids.managera]) {
      expect((await report(uid, "2026-10-08", "2026-10-08", "biz-b")).body.error).toBe("business-access-denied");
      const own = await report(uid, "2026-10-08", "2026-10-08");
      expect(JSON.stringify(own.body)).not.toContain("999900");
      expect(own.body.overview.netSales).toBeNull();
    }
  });

  it("suspended businesses can still read reports (read-only)", async () => {
    expect((await report(world.uids.owners, "2026-10-08", "2026-10-08", "biz-s")).status).toBe(200);
  });

  it("a bridal workspace doesn't get Reports, even with reports.view or a forged snapshot", async () => {
    await createBusiness({ ...world, name: "Wedding", planId: "pro", workspaceTemplateId: "bridal-expense", businessId: "biz-w" });
    const u = await ensureAuthUser({ auth: world.auth, email: "bride2@t.test", name: "Bride" });
    await addMember({ ...world, businessId: "biz-w", uid: u.uid, email: u.email, name: "Bride", roleTemplate: "owner", isAccountOwner: true });
    expect((await report(u.uid, "2026-10-08", "2026-10-08", "biz-w")).status).toBe(403);
    docAt("businesses/biz-w").entitlements.modules.reports = true;
    expect((await report(u.uid, "2026-10-08", "2026-10-08", "biz-w")).status).toBe(503);
  });

  it("the walk-in key never collides with a customer id", () => {
    expect(WALK_IN_KEY).toMatch(/^_/);
  });
});
