// Backfill (2026-11-03): past orders typed with a customer's name get a
// Customers record with the live New Order rules (same name is a warning,
// never a match), oldest first; walk-ins and already-linked orders untouched;
// stats equal the linked live orders, and later payments / cancels keep them
// right. Dry run writes nothing; a second run finds nothing to do.

import { describe, it, expect, beforeEach } from "vitest";
import { createCustomer, setCustomerStatus } from "../../netlify/functions/_lib/customers.js";
import { createOrder, cancelOrder } from "../../netlify/functions/_lib/orders.js";
import { recordPayment } from "../../netlify/functions/_lib/payments.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { backfillOrderCustomers } from "../../netlify/functions/_lib/customer-backfill.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-owner", name: "Owner", email: "" };
const BIZ = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" };
let world;
let A;
let productId;
let k = 0;
const docAt = (p) => world.db.docs.get(p);
const common = () => ({ db: world.db, tenant: A, FieldValue, actor });
const customers = () => [...world.db.docs.entries()].filter(([p]) => /^businesses\/biz-a\/customers\/[^/]+$/.test(p)).map(([p, d]) => ({ id: p.split("/").pop(), ...d }));
const orderDoc = (id) => docAt(`businesses/biz-a/orders/${id}`);

beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
  ({ productId } = await createProduct({ ...common(), input: { sku: "BF-1", name: "Wings", unit: "pcs", sellingPrice: 10000, reorderLevel: 0 } }));
  await recordMovement({ ...common(), productId, movement: { type: "opening", quantity: Q(100), unitCost: 5000, note: "count" } });
});

// An order as it was before customers were saved automatically: the typed
// name and phone on the order, no customerId.
async function pastOrder(day, customer, { qty = 1, deliveryAddress = "" } = {}) {
  const { orderId } = await createOrder({ ...common(), business: BIZ, entitlements: docAt("businesses/biz-a").entitlements, input: { customer: { name: "Walk-in" }, source: "phone", items: [{ productId, quantity: Q(qty) }] }, idempotencyKey: `bf-key-${String(++k).padStart(12, "0")}`, canDiscount: false, now: new Date(`2026-10-${day}T03:00:00Z`) });
  world.db.seed(`businesses/biz-a/orders/${orderId}`, { ...orderDoc(orderId), customer: { name: customer.name, phone: customer.phone ?? "", notes: "" }, deliveryAddress, customerId: null, orderDate: `2026-10-${day}` });
  return orderId;
}
const run = (apply) => backfillOrderCustomers({ ...common(), apply });

describe("backfill customers from past orders", () => {
  it("dry run reports and writes nothing; apply creates one customer per new name, links every order, stats right", async () => {
    const o1 = await pastOrder("05", { name: "Erika", phone: "0917 111 2222" }, { qty: 2 });
    const o2 = await pastOrder("06", { name: "ERIKA ", phone: "+63 917-111-2222" });
    const o3 = await pastOrder("07", { name: "Lea" });
    const w = await pastOrder("07", { name: "Walk-in" });
    const before = world.db.docs.size;
    const dry = await run(false);
    expect(world.db.docs.size).toBe(before);
    expect(dry.applied).toBe(false);
    expect(dry.created.map((c) => [c.name, c.orders.length])).toEqual([["Erika", 2], ["Lea", 1]]);
    expect(dry.skipped).toEqual([{ orderNumber: orderDoc(w).orderNumber, name: "Walk-in", reason: "walk-in" }]);

    const done = await run(true);
    expect(done.applied).toBe(true);
    const erika = customers().find((c) => c.name === "Erika");
    expect(erika).toMatchObject({ phone: "0917 111 2222", savedFrom: "backfill", status: "active", stats: { orderCount: 2, totalOrdered: 30000, outstandingBalance: 30000, lastOrderNumber: orderDoc(o2).orderNumber } });
    expect(erika.history[0].label).toBe(`Saved from past orders ${orderDoc(o1).orderNumber}, ${orderDoc(o2).orderNumber}`);
    expect([orderDoc(o1).customerId, orderDoc(o2).customerId]).toEqual([erika.id, erika.id]);
    expect(orderDoc(o1).revision).toBe(2);
    expect(orderDoc(o3).customerId).toBe(customers().find((c) => c.name === "Lea").id);
    expect(orderDoc(w).customerId).toBeNull();
    // Order snapshots and totals never change.
    expect(orderDoc(o2).customer.name).toBe("ERIKA ");
    expect(orderDoc(o1).total).toBe(20000);
    const audit = [...world.db.docs.values()].find((d) => d.type === "customers.backfilled");
    expect(audit).toMatchObject({ created: 2, matched: 0 });
    expect(audit.linked).toHaveLength(3);

    // Nothing left to do; a second run changes nothing.
    const again = await run(true);
    expect([again.linked.length, again.applied]).toEqual([0, false]);
    expect(customers()).toHaveLength(2);
  });

  it("same name is a warning: existing same-name customer with another phone → left unlinked; same phone or address → linked, phone filled once", async () => {
    const { customerId: maria } = await createCustomer({ ...common(), input: { name: "Maria Santos", phone: "0917 123 4567" } });
    const { customerId: juan } = await createCustomer({ ...common(), input: { name: "Juan Cruz", address: "12 Rizal St., Makati" } });
    const byPhone = await pastOrder("05", { name: "maria santos", phone: "09171234567" });
    const other = await pastOrder("05", { name: "Maria Santos", phone: "0999 000 1111" });
    const nameOnly = await pastOrder("06", { name: "Maria Santos" });
    const byAddress = await pastOrder("06", { name: "Juan Cruz", phone: "0918 555 6666" }, { deliveryAddress: "12 Rizal St Makati" });
    const r = await run(true);
    expect(orderDoc(byPhone).customerId).toBe(maria);
    expect(orderDoc(byAddress).customerId).toBe(juan);
    expect([orderDoc(other).customerId, orderDoc(nameOnly).customerId]).toEqual([null, null]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["same-name", "same-name"]);
    expect(customers()).toHaveLength(2);
    const j = docAt(`businesses/biz-a/customers/${juan}`);
    expect(j).toMatchObject({ phone: "0918 555 6666", revision: 2, stats: { orderCount: 1, totalOrdered: 10000 } });
    expect(j.history.at(-1).label).toContain("Phone added 0918 555 6666");
    expect(docAt(`businesses/biz-a/customers/${maria}`).stats).toMatchObject({ orderCount: 1, totalOrdered: 10000, outstandingBalance: 10000 });
  });

  it("a customer created earlier in the run counts for later orders (oldest first); inactive customers and linked orders are left alone", async () => {
    const first = await pastOrder("03", { name: "Lea", phone: "0917 000 0001" });
    const later = await pastOrder("09", { name: "Lea", phone: "0917 000 0002" });
    const { customerId: old } = await createCustomer({ ...common(), input: { name: "Old Buyer", phone: "0917 999 8888" } });
    await setCustomerStatus({ ...common(), customerId: old, status: "inactive" });
    const toInactive = await pastOrder("04", { name: "Old Buyer", phone: "0917 999 8888" });
    const r = await run(true);
    expect(orderDoc(first).customerId).toBe(customers().find((c) => c.name === "Lea").id);
    expect(orderDoc(later).customerId).toBeNull();
    expect(orderDoc(toInactive).customerId).toBeNull();
    expect(r.skipped.map((s) => [s.orderNumber, s.reason])).toEqual([[orderDoc(toInactive).orderNumber, "inactive"], [orderDoc(later).orderNumber, "same-name"]]);
  });

  it("cancelled orders link without counting; paid amounts lower the balance; later payments and cancels keep the stats equal to the orders", async () => {
    const paid = await pastOrder("05", { name: "Erika", phone: "0917 111 2222" }, { qty: 3 });
    await recordPayment({ ...common(), bucket: world.bucket, business: BIZ, orderId: paid, input: { amount: 10000, method: "cash" }, canVerify: true });
    const gone = await pastOrder("06", { name: "Erika", phone: "0917 111 2222" });
    await cancelOrder({ ...common(), business: BIZ, orderId: gone, reason: "changed mind" });
    await run(true);
    const erika = customers().find((c) => c.name === "Erika");
    expect(orderDoc(gone).customerId).toBe(erika.id);
    expect(erika.stats).toMatchObject({ orderCount: 1, totalOrdered: 30000, outstandingBalance: 20000, lastOrderNumber: orderDoc(paid).orderNumber });
    // Live changes after the backfill move the same stats.
    await recordPayment({ ...common(), bucket: world.bucket, business: BIZ, orderId: paid, input: { amount: 5000, method: "cash" }, canVerify: true });
    expect(docAt(`businesses/biz-a/customers/${erika.id}`).stats).toMatchObject({ orderCount: 1, totalOrdered: 30000, outstandingBalance: 15000 });
  });

  it("only this business: another business's orders and customers are never read or changed", async () => {
    await pastOrder("05", { name: "Erika" });
    const B = tenantDb(world.db, "biz-b");
    const snapshot = JSON.stringify([...world.db.docs.entries()].filter(([p]) => p.startsWith("businesses/biz-b/")));
    await run(true);
    expect(JSON.stringify([...world.db.docs.entries()].filter(([p]) => p.startsWith("businesses/biz-b/")))).toBe(snapshot);
    expect((await B.collection("customers").get()).empty).toBe(true);
  });
});
