// Phase 10: Expenses. Validation, the metric consequences of create /
// edit / remove (including moving between days and months), the required
// profitability scenario, and the API's permission / workspace / tenant /
// subscription guards.

import { describe, it, expect, beforeEach } from "vitest";
import { createExpense, updateExpense, removeExpense } from "../../netlify/functions/_lib/expenses.js";
import { createOrder, fulfillOrder } from "../../netlify/functions/_lib/orders.js";
import { recordPayment } from "../../netlify/functions/_lib/payments.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createCustomer } from "../../netlify/functions/_lib/customers.js";
import { createExpensesHandler } from "../../netlify/functions/expenses.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { createBusiness, addMember, ensureAuthUser, updateOverrides } from "../../netlify/functions/_lib/provisioning.js";
import { validateExpenseInput } from "../../shared/expenses.js";
import { financialSummary } from "../../shared/finance.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-carlo", name: "Carlo", email: "c@t.test" };
const BIZ = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" };
const NOW = new Date("2026-10-08T06:00:00Z"); // 14:00 Manila, Oct 8
let world;
let A;
let k = 0;

beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});

const docAt = (p) => world.db.docs.get(p);
const fin = (id) => docAt(`businesses/biz-a/financialMetrics/${id}`) || {};
const opexOn = (id) => fin(id).operatingExpenses ?? 0;
const exp = (id) => docAt(`businesses/biz-a/expenses/${id}`);
const common = () => ({ db: world.db, tenant: A, FieldValue, business: BIZ, actor, now: NOW });
const add = (over = {}) => createExpense({ ...common(), input: { date: "2026-10-08", category: "packaging", amount: 200000, method: "cash", ...over } });

// Invariant: every day/month document's operatingExpenses equals the sum
// of the ACTIVE expenses dated in it.
function expectMetricsMatchExpenses() {
  const active = [...world.db.docs.entries()].filter(([p, d]) => p.startsWith("businesses/biz-a/expenses/") && d.status === "active").map(([, d]) => d);
  const sum = (pred) => active.filter(pred).reduce((s, e) => s + e.amount, 0);
  for (const [p, d] of world.db.docs.entries()) {
    const m = /^businesses\/biz-a\/financialMetrics\/(\d{4}-\d{2}(?:-\d{2})?)$/.exec(p);
    if (!m) continue;
    const id = m[1];
    expect(d.operatingExpenses ?? 0, id).toBe(sum((e) => (id.length === 10 ? e.date === id : e.month === id)));
  }
}

describe("validation", () => {
  const ok = { date: "2026-10-08", category: "rent", amount: 100, method: "cash" };
  it("amounts are integer centavos > 0; no floats, strings or negatives", () => {
    for (const amount of [0, -100, 10.5, "1500", null, Number.NaN, 1e15]) expect(() => validateExpenseInput({ ...ok, amount }), String(amount)).toThrow();
    expect(validateExpenseInput(ok).amount).toBe(100);
  });
  it("dates are real business-local days, never in the future", () => {
    expect(() => validateExpenseInput({ ...ok, date: "2026-02-30" })).toThrow(/valid date/);
    expect(() => validateExpenseInput({ ...ok, date: "2026-10-09" }, { today: "2026-10-08" })).toThrow(/future/);
    expect(validateExpenseInput({ ...ok, date: "2025-01-31" }, { today: "2026-10-08" }).date).toBe("2025-01-31");
  });
  it("category and method from the lists; forged metrics, status or authors refused", () => {
    expect(() => validateExpenseInput({ ...ok, category: "bribes" })).toThrow(/category/);
    expect(() => validateExpenseInput({ ...ok, method: "crypto" })).toThrow(/method/);
    for (const extra of [{ operatingExpenses: 0 }, { status: "removed" }, { createdBy: { name: "x" } }, { createdAt: "2020-01-01" }, { businessId: "biz-b" }]) {
      expect(() => validateExpenseInput({ ...ok, ...extra }), JSON.stringify(extra)).toThrow(/can't be set/);
    }
  });
});

describe("metrics follow every change", () => {
  it("create: Operating Expenses += amount on the day and its month; nothing else moves", async () => {
    await add();
    expect(fin("2026-10-08")).toMatchObject({ operatingExpenses: 200000, grossSales: 0, cogs: 0, paymentsReceived: 0 });
    expect(fin("2026-10").operatingExpenses).toBe(200000);
    expect(docAt("businesses/biz-a/financialMetrics/current")).toBeUndefined();
  });

  it("edit amount ₱2,000 → ₱1,500: the day and month move by -₱500; the log says so", async () => {
    const { expenseId } = await add();
    await updateExpense({ ...common(), expenseId, changes: { amount: 150000 } });
    expect(opexOn("2026-10-08")).toBe(150000);
    expect(opexOn("2026-10")).toBe(150000);
    expect(exp(expenseId).history.at(-1).label).toBe("Amount changed ₱2,000 → ₱1,500");
    expectMetricsMatchExpenses();
  });

  it("edit date across months: removed from Oct 8 / October, added to Sep 30 / September", async () => {
    const { expenseId } = await add();
    await updateExpense({ ...common(), expenseId, changes: { date: "2026-09-30", amount: 120000 } });
    expect(opexOn("2026-10-08")).toBe(0);
    expect(opexOn("2026-10")).toBe(0);
    expect(opexOn("2026-09-30")).toBe(120000);
    expect(opexOn("2026-09")).toBe(120000);
    expect(exp(expenseId)).toMatchObject({ date: "2026-09-30", month: "2026-09", revision: 2 });
    expectMetricsMatchExpenses();
  });

  it("edit category: metrics unchanged, history readable", async () => {
    const { expenseId } = await add();
    await updateExpense({ ...common(), expenseId, changes: { category: "supplies" } });
    expect(opexOn("2026-10-08")).toBe(200000);
    expect(exp(expenseId).history.at(-1).label).toBe("Category changed Packaging → Supplies");
  });

  it("remove (reason required): stops counting, kept for audit, can't be edited or removed again", async () => {
    const { expenseId } = await add();
    await expect(removeExpense({ ...common(), expenseId, reason: "" })).rejects.toMatchObject({ code: "reason-required" });
    await removeExpense({ ...common(), expenseId, reason: "Duplicate entry" });
    expect(opexOn("2026-10-08")).toBe(0);
    expect(exp(expenseId)).toMatchObject({ status: "removed", removalReason: "Duplicate entry", amount: 200000 });
    expect(exp(expenseId).history.at(-1)).toMatchObject({ type: "removed", reason: "Duplicate entry", label: "Removed expense ₱2,000" });
    await expect(updateExpense({ ...common(), expenseId, changes: { amount: 1 } })).rejects.toMatchObject({ code: "removed" });
    await expect(removeExpense({ ...common(), expenseId, reason: "again" })).rejects.toMatchObject({ code: "removed" });
  });

  it("historical expense (last year) corrects that day and month, not today", async () => {
    await add({ date: "2025-12-31", amount: 50000 });
    expect(opexOn("2025-12-31")).toBe(50000);
    expect(opexOn("2025-12")).toBe(50000);
    expect(opexOn("2026-10-08")).toBe(0);
  });

  it("stale revision and future date on edit are refused", async () => {
    const { expenseId } = await add();
    await expect(updateExpense({ ...common(), expenseId, changes: { amount: 1 }, expectedRevision: 9 })).rejects.toMatchObject({ code: "stale-expense" });
    await expect(updateExpense({ ...common(), expenseId, changes: { date: "2026-10-09" } })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("a long sequence of creates / edits / removes keeps every day and month exact", async () => {
    const ids = [];
    for (const [date, amount] of [["2026-10-08", 1000], ["2026-10-07", 2500], ["2026-09-15", 999], ["2026-10-08", 40000]]) ids.push((await add({ date, amount })).expenseId);
    await updateExpense({ ...common(), expenseId: ids[0], changes: { date: "2026-09-15" } });
    await updateExpense({ ...common(), expenseId: ids[1], changes: { amount: 3000, date: "2026-10-08" } });
    await removeExpense({ ...common(), expenseId: ids[2], reason: "typo" });
    expectMetricsMatchExpenses();
  });
});

describe("THE scenario: Sales ₱10,000, COGS ₱6,000 → expense ₱1,500 → ₱1,000 → removed", () => {
  it("only Operating Expenses and Estimated Operating Profit move", async () => {
    const { productId } = await createProduct({ ...common(), input: { sku: "WINGS", name: "Wings", unit: "pcs", sellingPrice: 100000, reorderLevel: 0 } });
    await recordMovement({ ...common(), productId, movement: { type: "opening", quantity: Q(20), unitCost: 60000, note: "count" } });
    const { customerId } = await createCustomer({ ...common(), input: { name: "ABC Store" } });
    const { orderId } = await createOrder({ ...common(), entitlements: docAt("businesses/biz-a").entitlements, input: { customer: {}, customerId, source: "viber", items: [{ productId, quantity: Q(10) }] }, idempotencyKey: "exp-scenario-key-0001", canDiscount: false, canLinkCustomers: true });
    await fulfillOrder({ ...common(), orderId });
    await recordPayment({ ...common(), bucket: world.bucket, orderId, input: { amount: 300000, method: "cash" }, canVerify: true });
    const before = { day: financialSummary(fin("2026-10-08")), product: structuredClone(docAt(`businesses/biz-a/products/${productId}`)), customer: structuredClone(docAt(`businesses/biz-a/customers/${customerId}`).stats) };
    expect(before.day).toMatchObject({ netSales: 1000000, cogs: 600000, grossProfit: 400000, paymentsReceived: 300000 });

    const { expenseId } = await add({ amount: 150000 });
    let day = financialSummary(fin("2026-10-08"));
    expect(day).toMatchObject({ netSales: 1000000, cogs: 600000, grossProfit: 400000, operatingExpenses: 150000, estimatedOperatingProfit: 250000, paymentsReceived: 300000 });

    await updateExpense({ ...common(), expenseId, changes: { amount: 100000 } });
    day = financialSummary(fin("2026-10-08"));
    expect(day).toMatchObject({ operatingExpenses: 100000, estimatedOperatingProfit: 300000, grossProfit: 400000 });

    await removeExpense({ ...common(), expenseId, reason: "Duplicate entry" });
    day = financialSummary(fin("2026-10-08"));
    expect(day).toMatchObject({ netSales: 1000000, cogs: 600000, grossProfit: 400000, operatingExpenses: 0, estimatedOperatingProfit: 400000, paymentsReceived: 300000 });
    expect(financialSummary(fin("2026-10"))).toMatchObject({ operatingExpenses: 0, estimatedOperatingProfit: 400000 });

    // Nothing else moved.
    expect(docAt(`businesses/biz-a/products/${productId}`)).toEqual(before.product);
    expect(docAt(`businesses/biz-a/customers/${customerId}`).stats).toEqual(before.customer);
    expect(docAt("businesses/biz-a/financialMetrics/current").receivablesOutstanding).toBe(700000);
  });
});

describe("POST /api/expenses", () => {
  const call = async (uid, body, businessId) => {
    const res = await createExpensesHandler({ getAdmin: async () => world, now: () => NOW })({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const create = { action: "create", expense: { date: "2026-10-08", category: "rent", amount: 500000, method: "bank_transfer", reference: "TRX-1" } };

  it("401 before anything about the body", async () => {
    expect((await createExpensesHandler({ getAdmin: async () => world })({ ...request({ method: "POST" }), body: "{x" })).statusCode).toBe(401);
  });

  it("owner and manager manage expenses; staff (no expenses.*) are refused", async () => {
    const r = await call(world.uids.ownera, create);
    expect(r).toMatchObject({ status: 201, body: { success: true } });
    expect(exp(r.body.expenseId).createdBy.uid).toBe(world.uids.ownera); // the server's identity, not the browser's
    expect((await call(world.uids.managera, { action: "update", expenseId: r.body.expenseId, changes: { amount: 450000 } })).status).toBe(200);
    for (const body of [create, { action: "update", expenseId: r.body.expenseId, changes: { amount: 1 } }, { action: "remove", expenseId: r.body.expenseId, reason: "hijack" }]) {
      const s = await call(world.uids.staffa, body);
      expect(s.status, body.action).toBe(403);
    }
    expect(opexOn("2026-10-08")).toBe(450000);
  });

  it("granular: expenses.create without expenses.delete can add but not remove", async () => {
    const u = await ensureAuthUser({ auth: world.auth, email: "bk@t.test", name: "Bookkeeper" });
    await addMember({ ...world, businessId: "biz-a", uid: u.uid, email: u.email, name: "Bookkeeper", roleTemplate: "staff", permissionOverrides: { grant: ["expenses.view", "expenses.create"] } });
    const r = await call(u.uid, create);
    expect(r.status).toBe(201);
    expect((await call(u.uid, { action: "remove", expenseId: r.body.expenseId, reason: "mine" })).status).toBe(403);
  });

  it("strict payloads: forged metrics, ids or unknown actions refused", async () => {
    expect((await call(world.uids.ownera, { ...create, operatingExpenses: 0 })).status).toBe(400);
    expect((await call(world.uids.ownera, { action: "create", expense: { ...create.expense, amount: 15.5 } })).status).toBe(400);
    expect((await call(world.uids.ownera, { action: "create", expense: { ...create.expense, createdBy: { uid: "x" } } })).status).toBe(400);
    expect((await call(world.uids.ownera, { action: "teleport" })).status).toBe(400);
    expect((await call(world.uids.ownera, { action: "update", expenseId: "../x", changes: { amount: 1 } })).status).toBe(400);
  });

  it("cross-tenant: A can't create in, edit or remove B's expenses, or move B's metrics", async () => {
    const B = tenantDb(world.db, "biz-b");
    const { expenseId } = await createExpense({ db: world.db, tenant: B, FieldValue, business: { ...BIZ, id: "biz-b" }, actor, now: NOW, input: { date: "2026-10-08", category: "rent", amount: 100000, method: "cash" } });
    for (const uid of [world.uids.ownera, world.uids.managera]) {
      expect((await call(uid, { action: "update", expenseId, changes: { amount: 1 } })).status).toBe(404);
      expect((await call(uid, { action: "remove", expenseId, reason: "hijack" })).status).toBe(404);
      expect((await call(uid, create, "biz-b")).body.error).toBe("business-access-denied");
    }
    expect(docAt(`businesses/biz-b/expenses/${expenseId}`)).toMatchObject({ amount: 100000, status: "active" });
    expect(docAt("businesses/biz-b/financialMetrics/2026-10-08").operatingExpenses).toBe(100000);
  });

  it("plan / add-on: an override switching Expenses off refuses it, even for the owner", async () => {
    await updateOverrides({ ...world, businessId: "biz-a", set: { modules: { expenses: false } }, actor: "t", reason: "expenses off" });
    expect((await call(world.uids.ownera, create)).status).toBe(403);
  });

  it("suspended subscription: read-only (writes refused)", async () => {
    expect((await call(world.uids.owners, { ...create }, "biz-s")).body.error).toBe("read-only");
  });

  it("non-Distributor workspace: refused although the code exists (Expenses is only planned there)", async () => {
    await createBusiness({ ...world, name: "Wedding", planId: "pro", workspaceTemplateId: "bridal-expense", businessId: "biz-w" });
    const u = await ensureAuthUser({ auth: world.auth, email: "bride@t.test", name: "Bride" });
    await addMember({ ...world, businessId: "biz-w", uid: u.uid, email: u.email, name: "Bride", roleTemplate: "owner", isAccountOwner: true });
    expect(docAt("businesses/biz-w").entitlements.modules.expenses).toBe(false);
    const r = await call(u.uid, create, "biz-w");
    expect(r).toMatchObject({ status: 403, body: { error: "forbidden" } });
    // A forged snapshot flag doesn't help: the validator rejects it (503).
    docAt("businesses/biz-w").entitlements.modules.expenses = true;
    expect((await call(u.uid, create, "biz-w")).status).toBe(503);
  });

  it("stale workspace snapshot (template version) fails closed", async () => {
    docAt("businesses/biz-a").entitlements.workspaceTemplateVersion = 1;
    expect((await call(world.uids.ownera, create)).status).toBe(503);
  });
});
