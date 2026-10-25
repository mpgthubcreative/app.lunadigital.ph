// Who owes us + opening balances (2026-10-25). A customer's balance (and
// the business's receivables) = their unpaid order balances + what's left of
// their opening balance. Unpaid, partial, paid, cancelled, voided payments,
// corrections and opening balances each count once; retries never double.

import { describe, it, expect, beforeEach } from "vitest";
import { recordPayment, voidPayment } from "../../netlify/functions/_lib/payments.js";
import { createOrder, cancelOrder } from "../../netlify/functions/_lib/orders.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createCustomer } from "../../netlify/functions/_lib/customers.js";
import { createOpeningBalance, payOpeningBalance, voidOpeningBalance } from "../../netlify/functions/_lib/opening-balances.js";
import { createCustomersHandler } from "../../netlify/functions/customers.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";
import { financialSummary } from "../../shared/finance.js";
import { receivableRows, balanceItems } from "../../src/modules/customers/receivables.js";

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
const key = () => `recv-key-${String(++n).padStart(10, "0")}`;
const owes = (id) => docAt(`businesses/biz-a/customers/${id}`).stats.outstandingBalance;
const receivables = () => docAt("businesses/biz-a/financialMetrics/current")?.receivablesOutstanding ?? 0;
const all = (col) => [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/biz-a/${col}/`) && k.split("/").length === 4).map(([k, v]) => ({ id: k.split("/")[3], ...v }));
let productId;
async function product() {
  ({ productId } = await createProduct({ ...c(), input: { sku: `R-${++n}`, name: "Siomai", unit: "pcs", sellingPrice: 10000, reorderLevel: 0 } }));
  await recordMovement({ ...c(), productId, movement: { type: "opening", quantity: Q(500), unitCost: 5000, note: "count" } });
}
const order = async (customerId, qty) => (await createOrder({ ...c(), business: BIZ, entitlements: docAt("businesses/biz-a").entitlements, input: { ...(customerId ? { customerId } : {}), customer: { name: customerId ? "Saved" : "Walk-in" }, source: "phone", items: [{ productId, quantity: Q(qty) }] }, idempotencyKey: key(), canDiscount: false, canLinkCustomers: true, now: NOW })).orderId;
const pay = (orderId, amount) => recordPayment({ ...c(), bucket: world.bucket, business: BIZ, orderId, input: { amount, method: "cash" }, canVerify: true, now: NOW, idempotencyKey: key() });
// The invariant: each customer's balance = their order balances + opening balances left.
function expectBalancesAddUp() {
  const orders = all("orders");
  const openings = all("openingBalances");
  for (const cu of all("customers")) {
    const fromOrders = orders.filter((o) => o.customerId === cu.id && o.fulfillmentStatus !== "cancelled").reduce((t, o) => t + o.balance, 0);
    const fromOpening = openings.filter((b) => b.customerId === cu.id).reduce((t, b) => t + b.balance, 0);
    expect(cu.stats.outstandingBalance, cu.name).toBe(fromOrders + fromOpening);
  }
  const total = orders.filter((o) => o.fulfillmentStatus !== "cancelled").reduce((t, o) => t + o.balance, 0) + openings.reduce((t, b) => t + b.balance, 0);
  expect(receivables()).toBe(total);
}

describe("who owes us: every case counted once", () => {
  it("unpaid, partial, paid, cancelled, voided payment, walk-in, opening balance: balances add up; the list and its total", async () => {
    await product();
    const abc = (await createCustomer({ ...c(), input: { name: "ABC Restaurant" } })).customerId;
    const maria = (await createCustomer({ ...c(), input: { name: "Maria's Mini Mart" } })).customerId;
    const juan = (await createCustomer({ ...c(), input: { name: "Juan Store" } })).customerId;
    const paidUp = (await createCustomer({ ...c(), input: { name: "Paid Up Co" } })).customerId;
    const o1 = await order(abc, 5); // ₱500 unpaid
    const o2 = await order(maria, 3); // ₱300, ₱100 paid
    await pay(o2, 10000);
    const o3 = await order(paidUp, 2); // paid in full
    await pay(o3, 20000);
    const o4 = await order(juan, 4); // cancelled after a voided payment
    const { paymentId } = await pay(o4, 5000);
    await voidPayment({ ...c(), business: BIZ, paymentId, reason: "Wrong order" });
    await cancelOrder({ ...c(), business: BIZ, orderId: o4, reason: "Customer cancelled", now: NOW });
    await order(null, 1); // walk-in, unpaid ₱100: in receivables, not on any customer
    // Juan owed ₱1,850 before Luna.
    const ob = await createOpeningBalance({ ...c(), customerId: juan, amount: 185000, effectiveDay: "2026-10-01", note: "From the old notebook", source: "setup_import", idempotencyKey: key() });
    expect({ abc: owes(abc), maria: owes(maria), juan: owes(juan), paidUp: owes(paidUp) }).toEqual({ abc: 50000, maria: 20000, juan: 185000, paidUp: 0 });
    expect(receivables()).toBe(50000 + 20000 + 185000 + 10000);
    expectBalancesAddUp();
    // Opening balances never become sales, orders or stock.
    const fin = financialSummary(docAt("businesses/biz-a/financialMetrics/2026-10-25"));
    expect(fin.grossSales).toBe(0); // nothing fulfilled today
    expect(all("orders")).toHaveLength(5);
    expect(docAt(`businesses/biz-a/products/${productId}`).onHand).toBe(Q(500));
    // The list: customers with a balance, biggest first, with the oldest unpaid date.
    const customers = all("customers").filter((x) => x.stats.outstandingBalance > 0).sort((a, b) => b.stats.outstandingBalance - a.stats.outstandingBalance);
    const view = receivableRows(customers, { orders: all("orders").filter((o) => o.balance > 0), openings: all("openingBalances").filter((b) => b.balance > 0), today: "2026-10-25" });
    expect(view.total).toBe(255000);
    expect(view.rows.map((r) => [r.name, r.balance, r.oldestDays])).toEqual([["Juan Store", 185000, 24], ["ABC Restaurant", 50000, 0], ["Maria's Mini Mart", 20000, 0]]);
    // What makes up Juan's balance: the opening balance only (the cancelled order isn't there).
    expect(balanceItems(juan, { orders: all("orders"), openings: all("openingBalances") }).map((i) => [i.kind, i.due])).toEqual([["opening", 185000]]);
    expect(ob.openingBalanceId).toMatch(/^ob[a-f0-9]{30}$/);
  });
  it("collecting an opening balance (retried), then voiding a mistaken one: each once, history kept", async () => {
    await product();
    const juan = (await createCustomer({ ...c(), input: { name: "Juan Store" } })).customerId;
    const k = key();
    const { openingBalanceId } = await createOpeningBalance({ ...c(), customerId: juan, amount: 100000, effectiveDay: "2026-10-01", idempotencyKey: k });
    // The same setup request again: one opening balance.
    expect(await createOpeningBalance({ ...c(), customerId: juan, amount: 100000, effectiveDay: "2026-10-01", idempotencyKey: k })).toMatchObject({ openingBalanceId, replayed: true });
    await expect(createOpeningBalance({ ...c(), customerId: juan, amount: 999, effectiveDay: "2026-10-01", idempotencyKey: k })).rejects.toMatchObject({ code: "idempotency-conflict" });
    expect(owes(juan)).toBe(100000);
    const pk = key();
    await payOpeningBalance({ ...c(), openingBalanceId, amount: 40000, method: "gcash", reference: "1234567890", idempotencyKey: pk });
    await payOpeningBalance({ ...c(), openingBalanceId, amount: 40000, method: "gcash", reference: "1234567890", idempotencyKey: pk });
    expect(owes(juan)).toBe(60000);
    expect(receivables()).toBe(60000);
    await expect(payOpeningBalance({ ...c(), openingBalanceId, amount: 60001, method: "cash", idempotencyKey: key() })).rejects.toMatchObject({ code: "overpayment" });
    await expect(voidOpeningBalance({ ...c(), openingBalanceId, reason: "Typo" })).rejects.toMatchObject({ code: "has-payments" });
    await payOpeningBalance({ ...c(), openingBalanceId, amount: 60000, method: "cash", idempotencyKey: key() });
    expect(docAt(`businesses/biz-a/openingBalances/${openingBalanceId}`)).toMatchObject({ paid: 100000, balance: 0, status: "settled" });
    expect(owes(juan)).toBe(0);
    // A mistaken one is voided (kept, with the reason); a second void is refused.
    const wrong = await createOpeningBalance({ ...c(), customerId: juan, amount: 50000, effectiveDay: "2026-10-01", idempotencyKey: key() });
    await voidOpeningBalance({ ...c(), openingBalanceId: wrong.openingBalanceId, reason: "Entered twice in the old sheet" });
    await expect(voidOpeningBalance({ ...c(), openingBalanceId: wrong.openingBalanceId, reason: "Again" })).rejects.toMatchObject({ code: "voided" });
    const v = docAt(`businesses/biz-a/openingBalances/${wrong.openingBalanceId}`);
    expect(v).toMatchObject({ status: "voided", balance: 0, amount: 50000 });
    expect(v.history.map((h) => h.type)).toEqual(["created", "voided"]);
    expect(owes(juan)).toBe(0);
    expectBalancesAddUp();
    // Collecting it never shows up as a sale or an order payment.
    expect(all("payments")).toEqual([]);
    expect(financialSummary(docAt("businesses/biz-a/financialMetrics/2026-10-25")).paymentsReceived ?? 0).toBe(0);
  });
  it("through the API: customers.manage, a key required, one business only", async () => {
    const juan = (await createCustomer({ ...c(), input: { name: "Juan Store" } })).customerId;
    const call = async (body, uid = world.uids.ownera, businessId = "biz-a") => {
      const res = await createCustomersHandler({ getAdmin: async () => world })({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    };
    const body = { action: "openingBalance", customerId: juan, amount: 50000, effectiveDay: "2026-10-01" };
    expect((await call(body)).status).toBe(400);
    const k = key();
    expect((await call({ ...body, idempotencyKey: k })).status).toBe(201);
    expect((await call({ ...body, idempotencyKey: k })).body).toMatchObject({ replayed: true });
    expect(owes(juan)).toBe(50000);
    expect((await call({ ...body, idempotencyKey: key() }, world.uids.ownerb, "biz-b")).status).toBe(404);
    expect([...world.db.docs.keys()].filter((p) => p.startsWith("businesses/biz-b/openingBalances/"))).toEqual([]);
  });
});
