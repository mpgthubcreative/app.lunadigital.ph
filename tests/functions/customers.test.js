// Phase 9: Distributor customers. Contact records, the order link, and the
// statistics the server keeps in step with every order and payment (so a
// customer's balance always equals the sum of its open orders' balances).

import { describe, it, expect, beforeEach } from "vitest";
import { createCustomer, updateCustomer, setCustomerStatus, deleteCustomer } from "../../netlify/functions/_lib/customers.js";
import { createOrder, updateOrder, fulfillOrder, cancelOrder, deleteOrder } from "../../netlify/functions/_lib/orders.js";
import { recordPayment, updatePayment, voidPayment } from "../../netlify/functions/_lib/payments.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createCustomersHandler } from "../../netlify/functions/customers.js";
import { createOrdersHandler } from "../../netlify/functions/orders.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { validateCustomerInput, phoneKey, CustomerError } from "../../shared/customers.js";
import { validateOrderInput } from "../../shared/orders.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-carlo", name: "Carlo", email: "c@t.test" };
const BIZ = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" };
const NOW = new Date("2026-10-08T05:22:00Z");
let world;
let A;
let k = 0;

beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});

const docAt = (p) => world.db.docs.get(p);
const cust = (id, bid = "biz-a") => docAt(`businesses/${bid}/customers/${id}`);
const stats = (id) => cust(id).stats;
const order = (id) => docAt(`businesses/biz-a/orders/${id}`);
const common = () => ({ db: world.db, tenant: A, FieldValue, actor });
const newCustomer = (input = { name: "ABC Store", phone: "0917 123 4567" }) => createCustomer({ ...common(), input });

let productId;
async function product(pricePesos = 1000) {
  ({ productId } = await createProduct({ ...common(), input: { sku: `C-${++k}`, name: "Wings", unit: "pcs", sellingPrice: pricePesos * 100, reorderLevel: 0 } }));
  await recordMovement({ ...common(), productId, movement: { type: "opening", quantity: Q(100), unitCost: pricePesos * 50, note: "count" } });
  return productId;
}
const orderFor = async (customerId, qty = 10, { canLinkCustomers = true, name = "Walk-in Juan" } = {}) =>
  createOrder({ ...common(), business: BIZ, entitlements: docAt("businesses/biz-a").entitlements, input: { customer: { name }, ...(customerId ? { customerId } : {}), source: "viber", items: [{ productId, quantity: Q(qty) }] }, idempotencyKey: `cust-key-${String(++k).padStart(10, "0")}`, canDiscount: false, canLinkCustomers, now: NOW });
const pay = (orderId, amount, method = "cash") => recordPayment({ ...common(), bucket: world.bucket, business: BIZ, orderId, input: { amount, method }, canVerify: true, now: NOW });

// The invariant: stats == the customer's non-cancelled orders.
function expectStatsMatchOrders(customerId) {
  const mine = [...world.db.docs.entries()].filter(([p, d]) => p.startsWith("businesses/biz-a/orders/") && d.customerId === customerId && d.fulfillmentStatus !== "cancelled").map(([, d]) => d);
  expect(stats(customerId)).toMatchObject({
    orderCount: mine.length,
    totalOrdered: mine.reduce((s, o) => s + o.total, 0),
    outstandingBalance: mine.reduce((s, o) => s + o.balance, 0),
  });
}

describe("validation", () => {
  it("accepts contact fields only, cleans them, and refuses stats or unknown keys", () => {
    expect(validateCustomerInput({ name: "  ABC   Store ", email: "Owner@ABC.ph", phone: "+63 917 123 4567" })).toMatchObject({ name: "ABC Store", email: "owner@abc.ph", phone: "+63 917 123 4567" });
    expect(() => validateCustomerInput({ name: "" })).toThrow(/required/);
    expect(() => validateCustomerInput({ name: "X", stats: { outstandingBalance: 0 } })).toThrow(/can't be set/);
    expect(() => validateCustomerInput({ name: "X", status: "active" })).toThrow(/can't be set/);
    expect(() => validateCustomerInput({ name: "X", email: "nope" })).toThrow(/email/);
    expect(() => validateCustomerInput({ name: "X", phone: "<script>" })).toThrow(/Phone/);
    expect(() => validateCustomerInput({}, { partial: true })).toThrow(/Nothing to change/);
  });

  it("phone keys match local and +63 forms (for duplicate hints)", () => {
    expect(phoneKey("+63 917 123 4567")).toBe(phoneKey("0917-123-4567"));
    expect(phoneKey("12")).toBeNull();
  });

  it("orders: a linked customer needs no typed name; a walk-in does", () => {
    expect(validateOrderInput({ customerId: "abcdefgh12345678", customer: {}, source: "phone", items: [{ productId: "prodAAAAAAAA", quantity: 1000 }] }).customerId).toBe("abcdefgh12345678");
    expect(() => validateOrderInput({ customer: {}, source: "phone", items: [{ productId: "prodAAAAAAAA", quantity: 1000 }] })).toThrow(/Customer name/);
    expect(() => validateOrderInput({ customerId: "../x", customer: {}, source: "phone", items: [] }, { requireItems: false })).toThrow(/Invalid customer/);
  });
});

describe("contact records", () => {
  it("create starts active with empty stats; a second customer with the same phone gets a hint, not a block", async () => {
    const a = await newCustomer();
    expect(cust(a.customerId)).toMatchObject({ name: "ABC Store", nameLower: "abc store", status: "active", stats: { orderCount: 0, totalOrdered: 0, outstandingBalance: 0 } });
    const b = await newCustomer({ name: "ABC Store Branch 2", phone: "+63 917 123 4567" });
    expect(b.possibleDuplicate).toEqual({ customerId: a.customerId, name: "ABC Store" });
  });

  it("Edit -> Save changes only what was sent and logs it in plain language", async () => {
    const { customerId } = await newCustomer();
    await updateCustomer({ ...common(), customerId, changes: { phone: "0918 000 0000", company: "ABC Trading" } });
    const c = cust(customerId);
    expect(c).toMatchObject({ phone: "0918 000 0000", company: "ABC Trading", name: "ABC Store", revision: 2 });
    expect(c.history.at(-1).label).toBe("Company changed — → ABC Trading · Phone changed 0917 123 4567 → 0918 000 0000");
    await expect(updateCustomer({ ...common(), customerId, changes: { name: "X" }, expectedRevision: 1 })).rejects.toMatchObject({ code: "stale-customer" });
  });

  it("deactivate / reactivate; an inactive customer can't be linked to a new order", async () => {
    await product();
    const { customerId } = await newCustomer();
    await setCustomerStatus({ ...common(), customerId, status: "inactive" });
    await expect(orderFor(customerId)).rejects.toMatchObject({ code: "customer-inactive" });
    await setCustomerStatus({ ...common(), customerId, status: "active" });
    await expect(orderFor(customerId)).resolves.toBeTruthy();
    expect(cust(customerId).history.map((h) => h.type)).toEqual(["created", "deactivated", "reactivated"]);
  });

  it("delete: only a never-ordered customer; otherwise deactivate", async () => {
    await product();
    const used = await newCustomer();
    const { orderId } = await orderFor(used.customerId);
    await cancelOrder({ ...common(), business: BIZ, orderId, reason: "changed mind", now: NOW });
    // Even with the order cancelled (stats back to 0), it was referenced.
    await expect(deleteCustomer({ ...common(), customerId: used.customerId })).rejects.toMatchObject({ code: "has-orders" });
    const mistake = await newCustomer({ name: "Typo Stor" });
    await deleteCustomer({ ...common(), customerId: mistake.customerId, reason: "typo" });
    expect(cust(mistake.customerId)).toBeUndefined();
    const audit = [...world.db.docs.values()].find((d) => d.type === "customer.deleted");
    expect(audit).toMatchObject({ customerId: mistake.customerId, reason: "typo", snapshot: { name: "Typo Stor" } });
  });
});

describe("orders link customers; stats move in the same transaction", () => {
  it("linking copies the name and phone from the customer record (not from the browser)", async () => {
    await product();
    const { customerId } = await newCustomer();
    const { orderId } = await orderFor(customerId, 2, { name: "Forged Name" });
    expect(order(orderId)).toMatchObject({ customerId, customer: { name: "ABC Store", phone: "0917 123 4567" }, customerNameLower: "abc store" });
  });

  it("walk-in orders change no customer", async () => {
    await product();
    const { customerId } = await newCustomer();
    const { orderId } = await orderFor(null);
    expect(order(orderId).customerId).toBeNull();
    expect(stats(customerId).orderCount).toBe(0);
  });

  it("THE flow: ₱10,000 order, ₱4,000 then ₱6,000 — balance follows; fulfil changes nothing", async () => {
    await product(1000);
    const { customerId } = await newCustomer();
    const { orderId, orderNumber } = await orderFor(customerId, 10);
    expect(stats(customerId)).toMatchObject({ orderCount: 1, totalOrdered: 1000000, outstandingBalance: 1000000, lastOrderNumber: orderNumber });
    await pay(orderId, 400000);
    expect(stats(customerId).outstandingBalance).toBe(600000);
    await fulfillOrder({ ...common(), business: BIZ, orderId, now: NOW });
    expect(stats(customerId).outstandingBalance).toBe(600000);
    await pay(orderId, 600000);
    expect(stats(customerId)).toMatchObject({ orderCount: 1, totalOrdered: 1000000, outstandingBalance: 0 });
    expectStatsMatchOrders(customerId);
  });

  it("payment edit and removal move the balance back", async () => {
    await product(1000);
    const { customerId } = await newCustomer();
    const { orderId } = await orderFor(customerId, 10);
    const p = await pay(orderId, 400000);
    await updatePayment({ ...common(), bucket: world.bucket, business: BIZ, paymentId: p.paymentId, changes: { amount: 300000 } });
    expect(stats(customerId).outstandingBalance).toBe(700000);
    await voidPayment({ ...common(), business: BIZ, paymentId: p.paymentId, reason: "entered twice" });
    expect(stats(customerId).outstandingBalance).toBe(1000000);
    expectStatsMatchOrders(customerId);
  });

  it("editing quantities, moving an order to another customer, unlinking", async () => {
    await product(1000);
    const a = await newCustomer();
    const b = await newCustomer({ name: "XYZ Mart" });
    const { orderId } = await orderFor(a.customerId, 10);
    await pay(orderId, 200000);
    const edit = (customerId, qty) => updateOrder({ ...common(), business: BIZ, orderId, input: { customer: { name: "x" }, ...(customerId ? { customerId } : {}), source: "viber", items: [{ productId, quantity: Q(qty) }] }, canDiscount: false, canLinkCustomers: true });
    await edit(a.customerId, 8);
    expect(stats(a.customerId)).toMatchObject({ orderCount: 1, totalOrdered: 800000, outstandingBalance: 600000 });
    await edit(b.customerId, 8);
    expect(stats(a.customerId)).toMatchObject({ orderCount: 0, totalOrdered: 0, outstandingBalance: 0 });
    expect(stats(b.customerId)).toMatchObject({ orderCount: 1, totalOrdered: 800000, outstandingBalance: 600000 });
    expect(order(orderId).customer.name).toBe("XYZ Mart");
    await edit(null, 8);
    expect(stats(b.customerId).orderCount).toBe(0);
    expect(order(orderId).customerId).toBeNull();
    for (const c of [a, b]) expectStatsMatchOrders(c.customerId);
  });

  it("a fulfilled-order correction (Phase 7.1) moves the customer's totals too", async () => {
    await product(1000);
    const { customerId } = await newCustomer();
    const { orderId } = await orderFor(customerId, 10);
    await fulfillOrder({ ...common(), business: BIZ, orderId, now: NOW });
    await updateOrder({ ...common(), business: BIZ, orderId, input: { customer: {}, customerId, source: "viber", items: [{ productId, quantity: Q(8) }] }, canDiscount: false, canLinkCustomers: true, canCorrect: true, reason: "Customer took 8" });
    expect(stats(customerId)).toMatchObject({ totalOrdered: 800000, outstandingBalance: 800000 });
    expectStatsMatchOrders(customerId);
  });

  it("cancel and delete take the order out of the customer's stats", async () => {
    await product(1000);
    const { customerId } = await newCustomer();
    const one = await orderFor(customerId, 1);
    const two = await orderFor(customerId, 2);
    await cancelOrder({ ...common(), business: BIZ, orderId: one.orderId, reason: "customer cancelled", now: NOW });
    expect(stats(customerId)).toMatchObject({ orderCount: 1, totalOrdered: 200000, outstandingBalance: 200000 });
    await deleteOrder({ ...common(), orderId: two.orderId, reason: "duplicate" });
    expect(stats(customerId)).toMatchObject({ orderCount: 0, totalOrdered: 0, outstandingBalance: 0 });
  });

  it("an order already linked to a now-inactive customer can still be edited (keeping the link)", async () => {
    await product(1000);
    const { customerId } = await newCustomer();
    const { orderId } = await orderFor(customerId, 2);
    await setCustomerStatus({ ...common(), customerId, status: "inactive" });
    await updateOrder({ ...common(), business: BIZ, orderId, input: { customer: {}, customerId, source: "viber", items: [{ productId, quantity: Q(3) }] }, canDiscount: false, canLinkCustomers: false });
    expect(stats(customerId).totalOrdered).toBe(300000);
  });

  it("linking needs the Customers module + customers.view; keeping a link doesn't", async () => {
    await product(1000);
    const { customerId } = await newCustomer();
    await expect(orderFor(customerId, 1, { canLinkCustomers: false })).rejects.toMatchObject({ code: "customer-not-allowed" });
    const walkIn = await orderFor(null, 1);
    await expect(updateOrder({ ...common(), business: BIZ, orderId: walkIn.orderId, input: { customer: {}, customerId, source: "viber", items: [{ productId, quantity: Q(1) }] }, canDiscount: false, canLinkCustomers: false })).rejects.toMatchObject({ code: "customer-not-allowed" });
  });

  it("a customer from another business can't be linked", async () => {
    await product(1000);
    const B = tenantDb(world.db, "biz-b");
    const { customerId } = await createCustomer({ db: world.db, tenant: B, FieldValue, actor, input: { name: "B's customer" } });
    await expect(orderFor(customerId, 1)).rejects.toMatchObject({ code: "customer-not-found" });
    expect(cust(customerId, "biz-b").stats.orderCount).toBe(0);
  });
});

describe("POST /api/customers and the orders endpoint", () => {
  const callCustomers = async (uid, body, businessId) => {
    const res = await createCustomersHandler({ getAdmin: async () => world })({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const callOrders = async (uid, body) => {
    const res = await createOrdersHandler({ getAdmin: async () => world, now: () => NOW })({ ...request({ uid, method: "POST" }), body: JSON.stringify(body) });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  it("401 first; strict payloads; stats can't be sent", async () => {
    expect((await createCustomersHandler({ getAdmin: async () => world })({ ...request({ method: "POST" }), body: "{x" })).statusCode).toBe(401);
    expect((await callCustomers(world.uids.staffa, { action: "create", customer: { name: "X", stats: { outstandingBalance: -1 } } })).status).toBe(400);
    expect((await callCustomers(world.uids.staffa, { action: "create", customer: { name: "X" }, status: "inactive" })).status).toBe(400);
    expect((await callCustomers(world.uids.staffa, { action: "teleport" })).status).toBe(400);
  });

  it("staff (customers.manage) creates and edits; without customers.manage: 403", async () => {
    const r = await callCustomers(world.uids.staffa, { action: "create", customer: { name: "Staff Store" } });
    expect(r).toMatchObject({ status: 201, body: { success: true } });
    const u = await ensureAuthUser({ auth: world.auth, email: "viewer@t.test", name: "Viewer" });
    await addMember({ ...world, businessId: "biz-a", uid: u.uid, email: u.email, name: "Viewer", roleTemplate: "staff", permissionOverrides: { revoke: ["customers.manage"] } });
    expect((await callCustomers(u.uid, { action: "update", customerId: r.body.customerId, changes: { name: "Hijack" } })).status).toBe(403);
  });

  it("cross-tenant: A can't touch B's customers (not found, never B's data)", async () => {
    const B = tenantDb(world.db, "biz-b");
    const { customerId } = await createCustomer({ db: world.db, tenant: B, FieldValue, actor, input: { name: "B Store" } });
    for (const action of [{ action: "update", customerId, changes: { name: "Hijack" } }, { action: "setStatus", customerId, status: "inactive" }, { action: "delete", customerId }]) {
      expect((await callCustomers(world.uids.ownera, action)).status).toBe(404);
    }
    expect((await callCustomers(world.uids.ownera, { action: "create", customer: { name: "X" } }, "biz-b")).body.error).toBe("business-access-denied");
    expect(cust(customerId, "biz-b")).toMatchObject({ name: "B Store", status: "active" });
  });

  it("orders endpoint: links a customer; staff without customers.view is refused the link", async () => {
    await product(1000);
    const { customerId } = await newCustomer();
    const ok = await callOrders(world.uids.staffa, { action: "create", idempotencyKey: "cust-api-key-00000001", order: { customer: {}, customerId, source: "phone", items: [{ productId, quantity: Q(1) }] } });
    expect(ok.status).toBe(201);
    expect(stats(customerId).orderCount).toBe(1);
    const u = await ensureAuthUser({ auth: world.auth, email: "nocust@t.test", name: "No Cust" });
    await addMember({ ...world, businessId: "biz-a", uid: u.uid, email: u.email, name: "No Cust", roleTemplate: "staff", permissionOverrides: { revoke: ["customers.view"] } });
    const no = await callOrders(u.uid, { action: "create", idempotencyKey: "cust-api-key-00000002", order: { customer: {}, customerId, source: "phone", items: [{ productId, quantity: Q(1) }] } });
    expect(no).toMatchObject({ status: 403, body: { error: "customer-not-allowed" } });
  });

  it("customer errors map to clean statuses on the orders endpoint", async () => {
    await product(1000);
    const { customerId } = await newCustomer();
    await setCustomerStatus({ ...common(), customerId, status: "inactive" });
    const r = await callOrders(world.uids.ownera, { action: "create", idempotencyKey: "cust-api-key-00000003", order: { customer: {}, customerId, source: "phone", items: [{ productId, quantity: Q(1) }] } });
    expect(r).toMatchObject({ status: 409, body: { error: "customer-inactive" } });
  });
});

it("CustomerError is exported for the endpoint's error mapping", () => {
  expect(new CustomerError("x", "y")).toBeInstanceOf(Error);
});
