// Reseller Package (2026-10-31): resellers by name only, a private menu link
// per reseller (no Luna account), selling price over the owner price, the
// commission (calculated vs final), payouts as a ledger (Unpaid / Partially
// Paid / Paid), the simple report, and isolation: a link sees only its own
// reseller, a business only its own resellers.
// 2026-11-01: commission is EARNED from verified customer payments (final ×
// verified ÷ total); payouts are capped at earned − paid; the report dates
// earned commission by the customer payment; Owner Net Profit excludes it.

import { describe, it, expect, beforeEach } from "vitest";
import { createProduct, recordMovement, updateProduct } from "../../netlify/functions/_lib/inventory.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { createResellersHandler } from "../../netlify/functions/resellers.js";
import { createResellerMenuHandler } from "../../netlify/functions/reseller-menu.js";
import { createPayHandler } from "../../netlify/functions/pay.js";
import { createOrdersHandler } from "../../netlify/functions/orders.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { createOrder, cancelOrder, updateOrder, fulfillOrder } from "../../netlify/functions/_lib/orders.js";
import { recordPayment, verifyPayment, voidPayment, updatePayment } from "../../netlify/functions/_lib/payments.js";
import { createExpense } from "../../netlify/functions/_lib/expenses.js";
import { createReportsHandler } from "../../netlify/functions/reports.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";
import { createWorkbookHandler } from "../../netlify/functions/workbook.js";
import { readXlsx } from "../../shared/xlsx.js";
import { unzipSync, strFromU8 } from "fflate";

const Q = (n) => n * QTY_SCALE;
const setup = { uid: "u-setup", name: "Setup", email: "" };
let NOW = new Date("2026-10-15T02:00:00Z");
let world;
let k = 0;
const key = () => `res-key-${String(++k).padStart(12, "0")}`;
const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const docAt = (p) => world.db.docs.get(p);

beforeEach(async () => {
  NOW = new Date("2026-10-15T02:00:00Z");
  world = await buildWorld();
  for (const [id, name] of [["res-a", "Res A"], ["res-b", "Res B"]]) {
    await createBusiness({ ...world, name, planId: "reseller-basic", workspaceTemplateId: "reseller", businessId: id });
    for (const [role, extra] of [["owner", { isAccountOwner: true }], ["staff", {}]]) {
      const user = await ensureAuthUser({ auth: world.auth, email: `${role}.${id}@t.test`, name: `${role} ${id}` });
      world.uids[`${role}-${id}`] = user.uid;
      await addMember({ ...world, businessId: id, uid: user.uid, email: user.email, name: `${role} ${id}`, roleTemplate: role, ...extra });
    }
  }
});

async function api(uid, body, businessId = "res-a") {
  const res = await createResellersHandler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const owner = (body, businessId = "res-a") => api(world.uids[`owner-${businessId}`], body, businessId);
async function menu(body) {
  const res = await createResellerMenuHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
async function product(businessId, { sku, name, price, cost = 0, qty = 50 }) {
  const tenant = tenantDb(world.db, businessId);
  const { productId } = await createProduct({ db: world.db, tenant, FieldValue, actor: setup, input: { sku, name, unit: "pcs", sellingPrice: price, reorderLevel: 0 } });
  if (qty) await recordMovement({ db: world.db, tenant, FieldValue, productId, actor: setup, movement: { type: "opening", quantity: Q(qty), unitCost: cost, note: "count" } });
  return productId;
}
async function reseller(name, businessId = "res-a") {
  const r = ok(await owner({ action: "create", reseller: { name } }, businessId), 201);
  return { id: r.resellerId, token: r.path.split("#")[1] };
}
const ORDER = (items, extra = {}) => ({ customerName: "Marian Santos", fulfillment: "pickup", items, ...extra });
async function sell(token, items, extra) {
  return menu({ action: "order", token, idempotencyKey: key(), order: ORDER(items, extra) });
}
const summary = async (id, businessId = "res-a") => ok(await owner({ action: "detail", resellerId: id }, businessId)).reseller;
const orderIdOf = (orderNumber, businessId = "res-a") => [...world.db.docs.entries()].find(([p, d]) => p.startsWith(`businesses/${businessId}/orders/`) && d.orderNumber === orderNumber)[0].split("/").pop();
// The customer pays the business (Customer → Business): verified by the
// Owner unless { verify: false } (waiting for verification).
let refN = 0;
const customerPays = (orderId, amount, { verify = true, businessId = "res-a" } = {}) =>
  recordPayment({ db: world.db, bucket: world.bucket, tenant: tenantDb(world.db, businessId), FieldValue, business: { id: businessId, timezone: "Asia/Manila" }, orderId, input: { amount, method: "cash", reference: `CASH-${++refN}` }, actor: setup, canVerify: verify, now: NOW });

describe("resellers: name only, a private link each", () => {
  it("Name is the only required field; no phone, email or login; each gets its own private link", async () => {
    expect((await owner({ action: "create", reseller: {} })).status).toBe(400);
    expect((await owner({ action: "create", reseller: { name: "   " } })).status).toBe(400);
    const riza = await reseller("Riza");
    const yanie = await reseller("Yanie");
    const veah = await reseller("Veah");
    expect(new Set([riza.token, yanie.token, veah.token]).size).toBe(3);
    expect(riza.token).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
    expect(docAt(`businesses/res-a/resellers/${riza.id}`)).toMatchObject({ name: "Riza", status: "active", earned: 0, paid: 0 });
    // No Luna account was created for them.
    expect([...world.auth.users?.values?.() ?? []].some((u) => /riza/i.test(u.displayName || u.name || ""))).toBe(false);
    const list = ok(await owner({ action: "list" })).resellers;
    expect(list.map((r) => [r.name, r.status, r.status === "active" && r.earned === 0])).toEqual([["Riza", "active", true], ["Veah", "active", true], ["Yanie", "active", true]]);
    // Copy link returns the same link; the token isn't the reseller id.
    expect(ok(await owner({ action: "link", resellerId: riza.id })).path).toBe(`/reseller#${riza.token}`);
    expect(riza.token.includes(riza.id)).toBe(false);
    ok(await owner({ action: "update", resellerId: riza.id, changes: { name: "Riza Cruz", notes: "Taguig" } }));
    expect(docAt(`businesses/res-a/resellers/${riza.id}`)).toMatchObject({ name: "Riza Cruz", notes: "Taguig" });
  });

  it("the link: works; deactivate stops it; reactivate restores it; regenerate replaces it (old stops); malformed fails safely", async () => {
    const riza = await reseller("Riza");
    expect(ok(await menu({ action: "view", token: riza.token })).reseller.name).toBe("Riza");
    ok(await owner({ action: "setStatus", resellerId: riza.id, status: "inactive" }));
    expect((await menu({ action: "view", token: riza.token })).status).toBe(404);
    ok(await owner({ action: "setStatus", resellerId: riza.id, status: "active" }));
    expect((await menu({ action: "view", token: riza.token })).status).toBe(200);
    const fresh = ok(await owner({ action: "link", resellerId: riza.id, rotate: true })).path.split("#")[1];
    expect(fresh).not.toBe(riza.token);
    expect((await menu({ action: "view", token: riza.token })).status).toBe(404);
    expect(ok(await menu({ action: "view", token: fresh })).reseller.name).toBe("Riza");
    for (const bad of ["", "x", "../../etc", "a".repeat(200), riza.id]) expect((await menu({ action: "view", token: bad })).status, bad).toBe(404);
    expect((await menu({ action: "view", token: fresh, extra: 1 })).status).toBe(400);
  });

  it("only Owner / Admin (resellers.*) manage resellers; Staff can't; a Distributor business has no Resellers", async () => {
    expect((await api(world.uids["staff-res-a"], { action: "list" })).status).toBe(403);
    expect((await api(world.uids.ownera, { action: "list" }, "biz-a")).status).toBe(403);
  });
});

describe("the private menu: owner price, selling price, commission", () => {
  it("shows the owner price and her selling price (never cost); a price below the owner price is refused, ₱0 commission is fine", async () => {
    const a = await product("res-a", { sku: "A1", name: "Product A", price: 50000, cost: 30000 });
    const riza = await reseller("Riza");
    const v = ok(await menu({ action: "view", token: riza.token }));
    expect(v.products).toEqual([expect.objectContaining({ id: a, name: "Product A", ownerPrice: 50000, sellingPrice: 50000 })]);
    expect(JSON.stringify(v)).not.toMatch(/cost|30000|avgCost/i);
    expect(v.commission).toEqual({ earned: 0, paid: 0, remaining: 0, status: "none", potential: 0 });
    expect((await menu({ action: "setPrice", token: riza.token, productId: a, price: 49999 }))).toMatchObject({ status: 409, body: { error: "below-owner-price", message: "Selling price is below the owner price." } });
    expect(ok(await menu({ action: "setPrice", token: riza.token, productId: a, price: 50000 }))).toMatchObject({ commission: 0 });
    expect(ok(await menu({ action: "setPrice", token: riza.token, productId: a, price: 65000 }))).toMatchObject({ commission: 15000 });
    expect(ok(await menu({ action: "view", token: riza.token })).products[0].sellingPrice).toBe(65000);
  });

  it("THE example: COGS ₱0, owner ₱500, Riza ₱650 × 2 → customer ₱1,300, owner ₱1,000, commission ₱300 (final ₱300, unpaid)", async () => {
    const a = await product("res-a", { sku: "A1", name: "Product A", price: 50000, cost: 0 });
    const riza = await reseller("Riza");
    const r = ok(await sell(riza.token, [{ productId: a, quantity: Q(2), sellingPrice: 65000 }]), 201);
    expect(r).toMatchObject({ total: 130000, ownerAmount: 100000, commission: 30000 });
    expect(r.payPath).toMatch(/^\/pay\//);
    const order = [...world.db.docs.entries()].find(([p, d]) => p.startsWith("businesses/res-a/orders/") && d.orderNumber === r.orderNumber)[1];
    expect(order).toMatchObject({ reseller: { id: riza.id, name: "Riza" }, resellerId: riza.id, total: 130000, commission: { calculated: 30000, final: 30000, adjusted: false }, paymentStatus: "unpaid", fulfillmentStatus: "pending", sourceNote: "Reseller · Riza · Pickup" });
    expect(order.items[0]).toMatchObject({ unitPrice: 65000, basePrice: 50000, commission: 30000, lineSubtotal: 130000 });
    // Nothing earned until the customer pays: ₱300 is the potential.
    expect(await summary(riza.id)).toMatchObject({ potential: 30000, earned: 0, paid: 0, remaining: 0, payoutStatus: "none" });
    // Stock: one business inventory (reserved like any order).
    expect(docAt(`businesses/res-a/products/${a}`).available).toBe(Q(48));
    // Her own orders, read-only.
    let mine = ok(await menu({ action: "view", token: riza.token })).orders;
    expect(mine).toEqual([expect.objectContaining({ orderNumber: r.orderNumber, total: 130000, ownerAmount: 100000, commission: 30000, earned: 0, payout: "none", paymentStatus: "unpaid", fulfillmentStatus: "pending" })]);
    await customerPays(orderIdOf(r.orderNumber), 130000);
    expect(await summary(riza.id)).toMatchObject({ potential: 30000, earned: 30000, paid: 0, remaining: 30000, payoutStatus: "unpaid" });
    mine = ok(await menu({ action: "view", token: riza.token })).orders;
    expect(mine[0]).toMatchObject({ commission: 30000, earned: 30000, payout: "unpaid", paymentStatus: "paid" });
  });

  it("Yanie at the owner price: commission ₱0 (valid); several items; a price below the owner price can't be ordered", async () => {
    const a = await product("res-a", { sku: "A1", name: "Product A", price: 50000 });
    const b = await product("res-a", { sku: "B1", name: "Product B", price: 20000 });
    const yanie = await reseller("Yanie");
    const r = ok(await sell(yanie.token, [{ productId: a, quantity: Q(1), sellingPrice: 50000 }, { productId: b, quantity: Q(3), sellingPrice: 25000 }]), 201);
    expect(r).toMatchObject({ total: 125000, ownerAmount: 110000, commission: 15000 });
    const z = ok(await sell(yanie.token, [{ productId: a, quantity: Q(1), sellingPrice: 50000 }]), 201);
    expect(z.commission).toBe(0);
    expect((await sell(yanie.token, [{ productId: a, quantity: Q(1), sellingPrice: 40000 }])).body).toMatchObject({ error: "below-owner-price" });
  });

  it("the customer's payment link shows the order total only (no owner price, commission or cost); a payment waits for the Owner", async () => {
    const a = await product("res-a", { sku: "A1", name: "Product A", price: 50000 });
    const riza = await reseller("Riza");
    const r = ok(await sell(riza.token, [{ productId: a, quantity: Q(2), sellingPrice: 65000 }]), 201);
    const token = r.payPath.split("/").pop();
    const pay = (body) => createPayHandler(deps())({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": "203.0.113.9" }, body: JSON.stringify(body) }).then((res) => ({ status: res.statusCode, body: JSON.parse(res.body) }));
    const view = ok(await pay({ action: "view", token }));
    expect(view.order.total).toBe(130000);
    expect(Object.keys(view.order).sort()).toEqual(["cancelled", "customer", "due", "orderNumber", "paid", "payable", "pending", "total"]);
    expect(JSON.stringify(view)).not.toMatch(/commission|basePrice|ownerPrice|owner|"(50000|100000|30000)"|:(50000|100000|30000)[,}]/i);
    ok(await pay({ action: "submit", token, idempotencyKey: key(), payment: { amount: 130000, method: "gcash", reference: "GC-123456" } }), 201);
    const order = [...world.db.docs.entries()].find(([p, d]) => p.startsWith("businesses/res-a/orders/") && d.orderNumber === r.orderNumber)[1];
    expect(order).toMatchObject({ verifiedPaid: 0, pendingPaid: 130000 });
    expect(order.paymentStatus).not.toBe("paid");
  });
});

describe("commission: override, history, payouts", () => {
  // paid: the customer has paid the whole order (verified), so the whole
  // commission is earned.
  async function rizaSale({ sellingPrice = 65000, qty = 2, paid = true } = {}) {
    const a = await product("res-a", { sku: `A${++k}`, name: "Product A", price: 50000 });
    const riza = await reseller("Riza");
    const r = ok(await sell(riza.token, [{ productId: a, quantity: Q(qty), sellingPrice }]), 201);
    const [path, order] = [...world.db.docs.entries()].find(([p, d]) => p.startsWith("businesses/res-a/orders/") && d.orderNumber === r.orderNumber);
    const orderId = path.split("/").pop();
    const payment = paid ? await customerPays(orderId, order.total) : null;
    return { a, riza, orderId, order, paymentId: payment?.paymentId ?? null };
  }

  it("Owner overrides ₱300 → ₱250: both kept; the report uses ₱250; the reseller can't change it", async () => {
    const { riza, orderId } = await rizaSale();
    const e = ok(await owner({ action: "editSale", orderId, finalCommission: 25000 }));
    expect(e.commission).toMatchObject({ calculated: 30000, final: 25000, adjusted: true });
    expect(await summary(riza.id)).toMatchObject({ earned: 25000, paid: 0, remaining: 25000, payoutStatus: "unpaid" });
    const rep = ok(await owner({ action: "report", from: "2026-10-01", to: "2026-10-31" })).report;
    expect(rep).toMatchObject({ total: 25000, rows: [expect.objectContaining({ name: "Riza", earned: 25000, status: "unpaid" })] });
    // No reseller-side way to set the final commission.
    expect((await menu({ action: "editSale", token: riza.token, orderId, finalCommission: 99999 })).status).toBe(400);
    expect((await api(world.uids["staff-res-a"], { action: "editSale", orderId, finalCommission: 1 })).status).toBe(403);
    expect(docAt(`businesses/res-a/orders/${orderId}`).statusHistory.at(-1)).toMatchObject({ type: "commission", changes: { commission: { calculated: { from: 30000, to: 30000 }, final: { from: 30000, to: 25000 } } } });
  });

  it("partial ₱100 then ₱150 → Paid, two payout records; overpaying is refused; never a negative balance", async () => {
    const { riza, orderId } = await rizaSale();
    ok(await owner({ action: "editSale", orderId, finalCommission: 25000 }));
    const pay = (amount, date) => owner({ action: "pay", resellerId: riza.id, idempotencyKey: key(), payout: { amount, method: "gcash", ...(date ? { date } : {}) } });
    expect(ok(await pay(10000, "2026-10-15"), 201)).toMatchObject({ earned: 25000, paid: 10000, remaining: 15000, status: "partial" });
    expect((await pay(20000)).body).toMatchObject({ error: "commission-overpaid" });
    expect(ok(await pay(15000), 201)).toMatchObject({ paid: 25000, remaining: 0, status: "paid" });
    expect((await pay(1)).body).toMatchObject({ error: "commission-overpaid" });
    const d = ok(await owner({ action: "detail", resellerId: riza.id }));
    expect(d.payouts.map((p) => [p.amount, p.method, p.state]).sort((x, y) => x[0] - y[0])).toEqual([[10000, "GCash", "paid"], [15000, "GCash", "paid"]]);
    expect(d.reseller).toMatchObject({ earned: 25000, paid: 25000, remaining: 0, payoutStatus: "paid" });
    // The same request again records once.
    const again = key();
    ok(await owner({ action: "editSale", orderId, finalCommission: 30000 }));
    expect((await owner({ action: "pay", resellerId: riza.id, idempotencyKey: again, payout: { amount: 5000 } })).status).toBe(201);
    expect((await owner({ action: "pay", resellerId: riza.id, idempotencyKey: again, payout: { amount: 5000 } })).body).toMatchObject({ alreadyRecorded: true });
    expect((await summary(riza.id)).paid).toBe(30000);
  });

  it("override after a partial payout is fine; reducing below what's paid is refused until a payout is reversed (kept in the ledger)", async () => {
    const { riza, orderId, paymentId } = await rizaSale();
    ok(await owner({ action: "pay", resellerId: riza.id, idempotencyKey: key(), payout: { amount: 10000 } }), 201);
    ok(await owner({ action: "editSale", orderId, finalCommission: 25000 }));
    expect(await summary(riza.id)).toMatchObject({ earned: 25000, paid: 10000, remaining: 15000, payoutStatus: "partial" });
    ok(await owner({ action: "pay", resellerId: riza.id, idempotencyKey: key(), payout: { amount: 15000 } }), 201);
    expect((await owner({ action: "editSale", orderId, finalCommission: 20000 })).body).toMatchObject({ error: "commission-below-paid" });
    // Removing the customer's payment would take back paid-out commission: refused the same way.
    const tenant = tenantDb(world.db, "res-a");
    await expect(voidPayment({ db: world.db, tenant, FieldValue, business: { timezone: "Asia/Manila" }, paymentId, reason: "Bounced transfer", actor: setup })).rejects.toMatchObject({ code: "commission-below-paid" });
    const payoutId = ok(await owner({ action: "detail", resellerId: riza.id })).payouts.find((p) => p.amount === 15000).id;
    expect((await owner({ action: "reversePayout", payoutId, reason: "x" })).status).toBe(400);
    ok(await owner({ action: "reversePayout", payoutId, reason: "Paid twice by mistake" }));
    ok(await owner({ action: "editSale", orderId, finalCommission: 20000 }));
    const d = ok(await owner({ action: "detail", resellerId: riza.id }));
    expect(d.reseller).toMatchObject({ earned: 20000, paid: 10000, remaining: 10000, payoutStatus: "partial" });
    expect(d.payouts.find((p) => p.id === payoutId)).toMatchObject({ state: "reversed", reversal: { reason: "Paid twice by mistake" } });
  });

  it("an order edit keeps the owner price snapshot and an override; a new price later never rewrites history; cancel releases the commission", async () => {
    const { a, riza, orderId } = await rizaSale({ paid: false });
    const tenant = tenantDb(world.db, "res-a");
    // November: the owner raises the price; October's order keeps ₱500.
    await updateProduct({ db: world.db, tenant, FieldValue, productId: a, changes: { sellingPrice: 55000 }, actor: setup });
    await updateOrder({ db: world.db, tenant, FieldValue, orderId, input: { customer: { name: "Marian Santos", phone: "", notes: "" }, source: "other", sourceNote: "Reseller · Riza", items: [{ productId: a, quantity: Q(3) }] }, actor: setup, canDiscount: false });
    let o = docAt(`businesses/res-a/orders/${orderId}`);
    expect(o.items[0]).toMatchObject({ unitPrice: 65000, basePrice: 50000, commission: 45000 });
    expect(o.commission).toMatchObject({ calculated: 45000, final: 45000, adjusted: false });
    expect(await summary(riza.id)).toMatchObject({ potential: 45000, earned: 0 });
    ok(await owner({ action: "editSale", orderId, finalCommission: 40000 }));
    await updateOrder({ db: world.db, tenant, FieldValue, orderId, input: { customer: { name: "Marian Santos", phone: "", notes: "" }, source: "other", sourceNote: "Reseller · Riza", items: [{ productId: a, quantity: Q(2) }] }, actor: setup, canDiscount: false });
    o = docAt(`businesses/res-a/orders/${orderId}`);
    expect(o.commission).toMatchObject({ calculated: 30000, final: 40000, adjusted: true }); // the override survives
    // Back to calculated, then cancel: nothing earned.
    ok(await owner({ action: "editSale", orderId, finalCommission: null }));
    expect(await summary(riza.id)).toMatchObject({ potential: 30000, earned: 0 });
    await cancelOrder({ db: world.db, tenant, FieldValue, business: { timezone: "Asia/Manila" }, orderId, reason: "Customer backed out", actor: setup });
    expect(await summary(riza.id)).toMatchObject({ potential: 0, earned: 0, payoutStatus: "none" });
  });

  it("editSale: selling price (open orders), another reseller, Direct Sale; below the owner price needs an explicit final commission", async () => {
    const { riza, orderId } = await rizaSale({ paid: false });
    const yanie = await reseller("Yanie");
    const line = docAt(`businesses/res-a/orders/${orderId}`).items[0].lineId;
    ok(await owner({ action: "editSale", orderId, prices: { [line]: 70000 } }));
    expect(docAt(`businesses/res-a/orders/${orderId}`)).toMatchObject({ total: 140000, commission: { calculated: 40000, final: 40000 } });
    expect((await owner({ action: "editSale", orderId, prices: { [line]: 45000 } })).body).toMatchObject({ error: "below-owner-price" });
    ok(await owner({ action: "editSale", orderId, prices: { [line]: 45000 }, finalCommission: 0 }));
    expect(docAt(`businesses/res-a/orders/${orderId}`).commission).toMatchObject({ calculated: -10000, final: 0, adjusted: true });
    ok(await owner({ action: "editSale", orderId, prices: { [line]: 65000 }, finalCommission: null }));
    ok(await owner({ action: "editSale", orderId, resellerId: yanie.id }));
    await customerPays(orderId, 130000);
    expect((await summary(riza.id)).earned).toBe(0);
    expect((await summary(yanie.id)).earned).toBe(30000);
    ok(await owner({ action: "editSale", orderId, resellerId: null }));
    expect(docAt(`businesses/res-a/orders/${orderId}`)).toMatchObject({ reseller: null, resellerId: null, commission: null });
    expect((await summary(yanie.id)).earned).toBe(0);
  });
});

describe("direct sales and the report", () => {
  it("a direct sale has no reseller and ₱0 commission and never appears in reseller totals", async () => {
    const a = await product("res-a", { sku: "A1", name: "Product A", price: 50000 });
    const riza = await reseller("Riza");
    const tenant = tenantDb(world.db, "res-a");
    const direct = await createOrder({ db: world.db, tenant, FieldValue, business: { timezone: "Asia/Manila" }, entitlements: docAt("businesses/res-a").entitlements, input: { customer: { name: "Walk-in", phone: "", notes: "" }, source: "walk_in", items: [{ productId: a, quantity: Q(1) }] }, idempotencyKey: key(), actor: setup, canDiscount: false, now: NOW });
    expect(docAt(`businesses/res-a/orders/${direct.orderId}`)).not.toHaveProperty("resellerId");
    const r = ok(await sell(riza.token, [{ productId: a, quantity: Q(1), sellingPrice: 60000 }]), 201);
    await customerPays(orderIdOf(r.orderNumber), 60000);
    await customerPays(direct.orderId, 50000);
    const rep = ok(await owner({ action: "report", from: "2026-10-01", to: "2026-10-31" })).report;
    expect(rep.total).toBe(10000);
    expect(rep.rows.map((r) => r.name)).toEqual(["Riza"]);
  });

  it("Today / this month / custom: earned on the day the customer's verified payment came in; payouts don't move it", async () => {
    const a = await product("res-a", { sku: "A1", name: "Product A", price: 50000 });
    const riza = await reseller("Riza");
    const yanie = await reseller("Yanie");
    const veah = await reseller("Veah");
    const sale = async (who, qty, price) => orderIdOf(ok(await sell(who.token, [{ productId: a, quantity: Q(qty), sellingPrice: price }]), 201).orderNumber);
    NOW = new Date("2026-10-10T02:00:00Z");
    const r1 = await sale(riza, 2, 65000); // ₱300 potential, ₱1,300
    const y1 = await sale(yanie, 3, 65000); // ₱450, ₱1,950
    await customerPays(r1, 130000);
    await customerPays(y1, 195000);
    NOW = new Date("2026-10-20T02:00:00Z");
    const v1 = await sale(veah, 5, 60000); // ₱500, ₱3,000
    await customerPays(v1, 300000);
    ok(await owner({ action: "pay", resellerId: yanie.id, idempotencyKey: key(), payout: { amount: 45000, date: "2026-10-20" } }), 201);
    // An October order the customer pays half of in October, the rest in November.
    const r2 = await sale(riza, 1, 70000); // ₱200 potential, ₱700
    await customerPays(r2, 35000); // → ₱100 earned in October
    NOW = new Date("2026-11-02T02:00:00Z");
    ok(await owner({ action: "pay", resellerId: riza.id, idempotencyKey: key(), payout: { amount: 10000, date: "2026-11-02" } }), 201);
    await customerPays(r2, 35000); // → ₱100 more, earned in November
    await sale(riza, 1, 90000); // November, unpaid: earns nothing (₱400 potential)
    const report = async (from, to) => ok(await owner({ action: "report", from, to })).report;
    const oct = await report("2026-10-01", "2026-10-31");
    expect(oct.total).toBe(135000);
    expect(oct.rows.map((r) => [r.name, r.earned, r.paid, r.remaining, r.status])).toEqual([["Veah", 50000, 0, 50000, "unpaid"], ["Yanie", 45000, 45000, 0, "paid"], ["Riza", 40000, 10000, 30000, "partial"]]);
    expect((await report("2026-11-01", "2026-11-02")).rows).toEqual([expect.objectContaining({ name: "Riza", earned: 10000, paid: 0, status: "unpaid", orders: 1 })]);
    expect((await report("2026-10-10", "2026-10-10")).total).toBe(75000);
    expect(await summary(riza.id)).toMatchObject({ potential: 30000 + 20000 + 40000, earned: 50000, paid: 10000, remaining: 40000 });
    expect((await owner({ action: "report", from: "2026-10-31", to: "2026-10-01" })).status).toBe(400);
  });
});

describe("isolation: links and tenants", () => {
  it("Riza's link never shows Yanie's or Veah's orders or commission; another business's reseller is never reachable", async () => {
    const a = await product("res-a", { sku: "A1", name: "Product A", price: 50000 });
    const bp = await product("res-b", { sku: "B1", name: "Other Biz Item", price: 99900 });
    const riza = await reseller("Riza");
    const yanie = await reseller("Yanie");
    const other = await reseller("Bea", "res-b");
    ok(await sell(yanie.token, [{ productId: a, quantity: Q(1), sellingPrice: 80000 }]), 201);
    const r = ok(await sell(riza.token, [{ productId: a, quantity: Q(1), sellingPrice: 60000 }]), 201);
    await customerPays(orderIdOf(r.orderNumber), 60000);
    const rv = ok(await menu({ action: "view", token: riza.token }));
    expect(rv.orders.map((o) => o.orderNumber)).toEqual([r.orderNumber]);
    expect(rv.commission.earned).toBe(10000);
    expect(JSON.stringify(rv)).not.toMatch(/Yanie|Bea|Other Biz Item|Res B/);
    // Riza can't order another business's product, nor get another reseller's payment link.
    expect((await sell(riza.token, [{ productId: bp, quantity: Q(1), sellingPrice: 99900 }])).status).toBe(409);
    const yanieOrder = ok(await menu({ action: "view", token: yanie.token })).orders[0].orderNumber;
    expect((await menu({ action: "payLink", token: riza.token, orderNumber: yanieOrder })).status).toBe(404);
    // Business B: its own resellers only.
    expect(ok(await owner({ action: "list" }, "res-b")).resellers.map((x) => x.name)).toEqual(["Bea"]);
    expect((await owner({ action: "detail", resellerId: riza.id }, "res-b")).status).toBe(404);
    expect((await owner({ action: "pay", resellerId: riza.id, idempotencyKey: key(), payout: { amount: 100 } }, "res-b")).status).toBe(404);
    expect((await owner({ action: "link", resellerId: riza.id }, "res-b")).status).toBe(404);
    expect((await api(world.uids["owner-res-b"], { action: "list" }, "res-a")).status).toBe(403);
    // B's link lists B's products only.
    expect(ok(await menu({ action: "view", token: other.token })).products.map((p) => p.name)).toEqual(["Other Biz Item"]);
    // A link copied onto another business's record doesn't open.
    world.db.seed(`businesses/res-b/resellerLinks/${riza.id}`, docAt(`businesses/res-a/resellerLinks/${riza.id}`));
    world.db.seed(`resellerMenuLinks/forged`, { businessId: "res-b", resellerId: riza.id });
    expect((await menu({ action: "view", token: riza.token })).status).toBe(200); // still only Business A's Riza
    expect(ok(await menu({ action: "view", token: riza.token })).business.name).toBe("Res A");
  });

  it("a suspended business's links stop; the records are server-only", async () => {
    const riza = await reseller("Riza");
    world.db.seed("businesses/res-a", { ...docAt("businesses/res-a"), subscription: { ...docAt("businesses/res-a").subscription, status: "suspended" } });
    expect((await menu({ action: "view", token: riza.token })).status).toBe(404);
  });
});

describe("Download Excel (Reseller workspace)", () => {
  async function workbook(uid, businessId) {
    const res = await createWorkbookHandler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify({}) });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    return Buffer.from(res.body, "base64");
  }
  const sheetNames = (bytes) => [...strFromU8(unzipSync(new Uint8Array(bytes))["xl/workbook.xml"]).matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
  const rows = (bytes, name) => readXlsx(bytes, { sheet: name, maxRows: 2000 }).rows;

  it("Orders gain Reseller, prices, owner amount, calculated / final commission and payout state; Resellers and Commission Payouts sheets", async () => {
    const a = await product("res-a", { sku: "A1", name: "Product A", price: 50000 });
    const riza = await reseller("Riza");
    const r = ok(await sell(riza.token, [{ productId: a, quantity: Q(2), sellingPrice: 65000 }]), 201);
    const orderId = [...world.db.docs.entries()].find(([p, d]) => p.startsWith("businesses/res-a/orders/") && d.orderNumber === r.orderNumber)[0].split("/").pop();
    ok(await owner({ action: "editSale", orderId, finalCommission: 25000 }));
    await customerPays(orderId, 130000);
    ok(await owner({ action: "pay", resellerId: riza.id, idempotencyKey: key(), payout: { amount: 10000, method: "gcash" } }), 201);
    const bytes = await workbook(world.uids["owner-res-a"], "res-a");
    expect(sheetNames(bytes)).toEqual(expect.arrayContaining(["Orders", "Resellers", "Commission Payouts"]));
    const orders = rows(bytes, "Orders");
    const head = orders[0];
    for (const h of ["Reseller", "Selling / Owner Price", "Owner Amount", "Commission per Item", "Calculated Commission", "Final Commission", "Commission Earned", "Commission Paid", "Commission Remaining", "Commission Status"]) expect(head).toContain(h);
    const line = orders.find((row) => row[0] === r.orderNumber);
    const col = (h) => line[head.indexOf(h)];
    expect(col("Reseller")).toBe("Riza");
    expect(col("Selling / Owner Price")).toBe("Product A @ ₱650.00 (owner ₱500.00)");
    expect(col("Commission per Item")).toBe("Product A: ₱300.00 · final set for the whole order");
    expect([col("Owner Amount"), col("Calculated Commission"), col("Final Commission"), col("Commission Earned"), col("Commission Paid"), col("Commission Remaining")]).toEqual(["1000", "300", "250", "250", "100", "150"]);
    expect(col("Commission Status")).toBe("Partially Paid");
    expect(rows(bytes, "Resellers")[1]).toEqual(["Riza", "Active", "250", "100", "150", "Partially Paid"]);
    expect(rows(bytes, "Commission Payouts")[1].slice(1, 4)).toEqual(["Riza", "100", "GCash"]);
  });

  it("Commission per Item: each line's final commission, 'adjusted from' the calculated one; direct sales blank", async () => {
    const a = await product("res-a", { sku: "A1", name: "Product A", price: 20000 });
    const b = await product("res-a", { sku: "B1", name: "Product B", price: 15000 });
    const riza = await reseller("Riza");
    const tenant = tenantDb(world.db, "res-a");
    const make = (input) => createOrder({ db: world.db, tenant, FieldValue, business: { timezone: "Asia/Manila" }, entitlements: docAt("businesses/res-a").entitlements, input: { customer: { name: "Walk-in", phone: "", notes: "" }, source: "phone", ...input }, idempotencyKey: key(), actor: setup, canDiscount: false, canResell: true, now: NOW });
    const sale = await make({ resellerId: riza.id, items: [{ productId: a, quantity: Q(1), sellingPrice: 25000, finalCommission: 4000 }, { productId: b, quantity: Q(1), sellingPrice: 25000 }] });
    const direct = await make({ items: [{ productId: a, quantity: Q(1) }] });
    const bytes = await workbook(world.uids["owner-res-a"], "res-a");
    const orders = rows(bytes, "Orders");
    const head = orders[0];
    const at = (orderId, h) => orders.find((row) => row[0] === docAt(`businesses/res-a/orders/${orderId}`).orderNumber)[head.indexOf(h)];
    expect(at(sale.orderId, "Commission per Item")).toBe("Product A: ₱40.00 (adjusted from ₱50.00); Product B: ₱100.00");
    expect([at(sale.orderId, "Calculated Commission"), at(sale.orderId, "Final Commission")]).toEqual(["150", "140"]);
    expect(at(direct.orderId, "Commission per Item") ?? "").toBe("");
  });

  it("a Distributor workbook is unchanged (no reseller columns or sheets)", async () => {
    const bytes = await workbook(world.uids.ownera, "biz-a");
    expect(sheetNames(bytes)).not.toContain("Resellers");
    expect(rows(bytes, "Orders")[0]).not.toContain("Reseller");
  });
});


describe("one permanent private link per reseller (2026-11-01)", () => {
  it("the same link always shows the live menu: new products, stock, owner price; no new link needed; reactivate keeps it", async () => {
    const tenant = tenantDb(world.db, "res-a");
    const a = await product("res-a", { sku: "A1", name: "Product A", price: 50000, qty: 10 });
    const riza = await reseller("Riza");
    const first = ok(await menu({ action: "view", token: riza.token }));
    expect(first.products.map((p) => [p.name, p.ownerPrice, p.max])).toEqual([["Product A", 50000, Q(10)]]);
    // The owner adds a product, receives stock and raises the owner price.
    await product("res-a", { sku: "B1", name: "Product B", price: 20000, qty: 5 });
    await recordMovement({ db: world.db, tenant, FieldValue, productId: a, actor: setup, movement: { type: "receipt", quantity: Q(15), unitCost: 0, note: "delivery" } });
    await updateProduct({ db: world.db, tenant, FieldValue, productId: a, changes: { sellingPrice: 55000 }, actor: setup });
    const later = ok(await menu({ action: "view", token: riza.token }));
    expect(later.products.map((p) => [p.name, p.ownerPrice, p.max])).toEqual([["Product A", 55000, Q(25)], ["Product B", 20000, Q(5)]]);
    // Copy link is still the very same link.
    expect(ok(await owner({ action: "link", resellerId: riza.id })).path).toBe(`/reseller#${riza.token}`);
    // Deactivate stops it; Reactivate brings back the SAME link.
    ok(await owner({ action: "setStatus", resellerId: riza.id, status: "inactive" }));
    expect((await menu({ action: "view", token: riza.token })).status).toBe(404);
    ok(await owner({ action: "setStatus", resellerId: riza.id, status: "active" }));
    expect(ok(await menu({ action: "view", token: riza.token })).reseller.name).toBe("Riza");
    expect(ok(await owner({ action: "link", resellerId: riza.id })).path).toBe(`/reseller#${riza.token}`);
    // Only Regenerate changes it: the old one stops, the new one is the permanent link.
    const fresh = ok(await owner({ action: "link", resellerId: riza.id, rotate: true })).path.split("#")[1];
    expect((await menu({ action: "view", token: riza.token })).status).toBe(404);
    expect(ok(await menu({ action: "view", token: fresh })).reseller.name).toBe("Riza");
    expect(ok(await owner({ action: "link", resellerId: riza.id })).path).toBe(`/reseller#${fresh}`);
  });
});

describe("commission is earned from verified customer payments (2026-11-01)", () => {
  // THE example: P1 owner ₱200 / sells ₱250 (₱50), P2 owner ₱150 / sells ₱250
  // (₱100): customer ₱500, owner ₱350, potential ₱150.
  async function example() {
    const p1 = await product("res-a", { sku: "P1", name: "Product 1", price: 20000, cost: 10000 });
    const p2 = await product("res-a", { sku: "P2", name: "Product 2", price: 15000, cost: 0 });
    const riza = await reseller("Riza");
    const r = ok(await sell(riza.token, [{ productId: p1, quantity: Q(1), sellingPrice: 25000 }, { productId: p2, quantity: Q(1), sellingPrice: 25000 }]), 201);
    expect(r).toMatchObject({ total: 50000, ownerAmount: 35000, commission: 15000 });
    return { riza, orderId: orderIdOf(r.orderNumber), p1, p2 };
  }
  const pay = (riza, amount) => owner({ action: "pay", resellerId: riza.id, idempotencyKey: key(), payout: { amount, method: "cash" } });

  it("THE test case: ₱200 verified → ₱60 earned; pay Riza ₱20 → ₱40 left; customer pays ₱300 → ₱150 earned, ₱130 left; pay ₱130 → Paid", async () => {
    const { riza, orderId } = await example();
    expect(await summary(riza.id)).toMatchObject({ potential: 15000, earned: 0, paid: 0, remaining: 0 });
    expect((await pay(riza, 100)).body).toMatchObject({ error: "commission-overpaid" }); // nothing earned yet
    await customerPays(orderId, 20000); // 40%
    expect(await summary(riza.id)).toMatchObject({ potential: 15000, earned: 6000, paid: 0, remaining: 6000, payoutStatus: "unpaid" });
    expect(ok(await pay(riza, 2000), 201)).toMatchObject({ earned: 6000, paid: 2000, remaining: 4000, status: "partial" });
    // Not the unearned ₱130: only the earned ₱40 can be paid out.
    expect((await pay(riza, 13000)).body).toMatchObject({ error: "commission-overpaid" });
    expect((await pay(riza, 4001)).body).toMatchObject({ error: "commission-overpaid" });
    let v = ok(await menu({ action: "view", token: riza.token }));
    expect(v.commission).toEqual({ potential: 15000, earned: 6000, paid: 2000, remaining: 4000, status: "partial" });
    expect(v.orders[0]).toMatchObject({ commission: 15000, earned: 6000 });
    await customerPays(orderId, 30000); // now ₱500 of ₱500
    expect(await summary(riza.id)).toMatchObject({ earned: 15000, paid: 2000, remaining: 13000, payoutStatus: "partial" });
    expect(ok(await pay(riza, 13000), 201)).toMatchObject({ earned: 15000, paid: 15000, remaining: 0, status: "paid" });
    v = ok(await menu({ action: "view", token: riza.token }));
    expect(v.commission).toEqual({ potential: 15000, earned: 15000, paid: 15000, remaining: 0, status: "paid" });
    // The report: ₱150 earned for Riza, never more.
    const rep = ok(await owner({ action: "report", from: "2026-10-01", to: "2026-10-31" })).report;
    expect(rep).toMatchObject({ total: 15000, rows: [expect.objectContaining({ name: "Riza", earned: 15000, paid: 15000, remaining: 0, status: "paid" })] });
  });

  it("20% / 40% / 100%: earned follows verified payments only; pending and rejected payments never count", async () => {
    const { riza, orderId } = await example();
    const tenant = tenantDb(world.db, "res-a");
    const pending = await customerPays(orderId, 10000, { verify: false }); // proof submitted, not verified
    expect((await summary(riza.id)).earned).toBe(0);
    await voidPayment({ db: world.db, tenant, FieldValue, business: { timezone: "Asia/Manila" }, paymentId: pending.paymentId, reason: "Rejected: wrong reference", actor: setup });
    expect((await summary(riza.id)).earned).toBe(0);
    const p20 = await customerPays(orderId, 10000, { verify: false });
    expect((await summary(riza.id)).earned).toBe(0);
    await verifyPayment({ db: world.db, tenant, FieldValue, paymentId: p20.paymentId, actor: setup }); // 20%
    expect((await summary(riza.id)).earned).toBe(3000);
    await customerPays(orderId, 10000); // 40%
    expect((await summary(riza.id)).earned).toBe(6000);
    // An edited verified payment restates it: ₱100 → ₱50 (30%).
    await updatePayment({ db: world.db, bucket: world.bucket, tenant, FieldValue, business: { id: "res-a", timezone: "Asia/Manila" }, paymentId: p20.paymentId, changes: { amount: 5000 }, actor: setup });
    expect((await summary(riza.id)).earned).toBe(4500);
    await customerPays(orderId, 35000); // 100%
    expect((await summary(riza.id)).earned).toBe(15000);
  });

  it("the Owner's final commission is what's earned from: ₱150 → ₱120 at 40% = ₱48", async () => {
    const { riza, orderId } = await example();
    ok(await owner({ action: "editSale", orderId, finalCommission: 12000 }));
    await customerPays(orderId, 20000);
    expect(await summary(riza.id)).toMatchObject({ potential: 12000, earned: 4800, remaining: 4800 });
    // An override that follows a payment restates earned too.
    ok(await owner({ action: "editSale", orderId, finalCommission: null }));
    expect((await summary(riza.id)).earned).toBe(6000);
  });

  it("rounding to the centavo: ₱100 commission, a third paid → ₱33.33; the pieces add up exactly", async () => {
    const p = await product("res-a", { sku: "R1", name: "Round", price: 20000 });
    const riza = await reseller("Riza");
    const r = ok(await sell(riza.token, [{ productId: p, quantity: Q(1), sellingPrice: 30000 }]), 201); // ₱300, ₱100 commission
    const orderId = orderIdOf(r.orderNumber);
    await customerPays(orderId, 10000);
    expect((await summary(riza.id)).earned).toBe(3333);
    await customerPays(orderId, 10000);
    expect((await summary(riza.id)).earned).toBe(6667);
    await customerPays(orderId, 10000);
    expect((await summary(riza.id)).earned).toBe(10000);
    expect(ok(await owner({ action: "report", from: "2026-10-01", to: "2026-10-31" })).report.total).toBe(10000);
  });

  it("a removed (refunded) verified payment takes its commission back; refused while it's paid out, until the payout is reversed; history kept", async () => {
    const { riza, orderId } = await example();
    const tenant = tenantDb(world.db, "res-a");
    const full = await customerPays(orderId, 50000);
    ok(await pay(riza, 15000), 201);
    await expect(voidPayment({ db: world.db, tenant, FieldValue, business: { timezone: "Asia/Manila" }, paymentId: full.paymentId, reason: "Refunded to customer", actor: setup })).rejects.toMatchObject({ code: "commission-below-paid" });
    expect(docAt(`businesses/res-a/orders/${orderId}`).verifiedPaid).toBe(50000); // nothing changed
    const payoutId = ok(await owner({ action: "detail", resellerId: riza.id })).payouts[0].id;
    ok(await owner({ action: "reversePayout", payoutId, reason: "Customer refunded" }));
    await voidPayment({ db: world.db, tenant, FieldValue, business: { timezone: "Asia/Manila" }, paymentId: full.paymentId, reason: "Refunded to customer", actor: setup });
    expect(await summary(riza.id)).toMatchObject({ earned: 0, paid: 0, remaining: 0 });
    // Unpaid now: cancelling it leaves nothing earned; both records stay.
    await cancelOrder({ db: world.db, tenant, FieldValue, business: { timezone: "Asia/Manila" }, orderId, reason: "Customer backed out", actor: setup });
    expect(await summary(riza.id)).toMatchObject({ potential: 0, earned: 0 });
    const d = ok(await owner({ action: "detail", resellerId: riza.id }));
    expect(d.payouts[0]).toMatchObject({ state: "reversed", reversal: { reason: "Customer refunded" } });
    expect(docAt(`businesses/res-a/payments/${full.paymentId}`)).toMatchObject({ state: "voided", voidReason: "Refunded to customer" });
  });

  it("an unpaid cancelled order earns nothing; Riza's earned never includes another reseller's payments", async () => {
    const { riza, orderId, p1 } = await example();
    const yanie = await reseller("Yanie");
    const y = ok(await sell(yanie.token, [{ productId: p1, quantity: Q(2), sellingPrice: 30000 }]), 201); // ₱200 potential
    await customerPays(orderIdOf(y.orderNumber), 60000);
    const tenant = tenantDb(world.db, "res-a");
    await cancelOrder({ db: world.db, tenant, FieldValue, business: { timezone: "Asia/Manila" }, orderId, reason: "Customer backed out", actor: setup });
    expect(await summary(riza.id)).toMatchObject({ potential: 0, earned: 0 });
    expect(await summary(yanie.id)).toMatchObject({ potential: 20000, earned: 20000 });
  });
});

describe("Reports: Owner Net Profit excludes the reseller's commission (2026-11-01)", () => {
  const BIZ = { id: "res-a", timezone: "Asia/Manila" };
  async function reportOf(from = "2026-10-01", to = "2026-10-15", businessId = "res-a", who = "owner") {
    const res = await createReportsHandler(deps())({ ...request({ uid: world.uids[`${who}-${businessId}`], businessId }), queryStringParameters: { from, to } });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    return JSON.parse(res.body);
  }
  const fulfill = (orderId) => fulfillOrder({ db: world.db, tenant: tenantDb(world.db, "res-a"), FieldValue, business: BIZ, orderId, actor: setup, now: NOW });

  it("COGS ₱100, owner ₱200, reseller sells ₱250: owner gross profit ₱100 (not ₱150, never ₱50); direct sales and expenses as usual", async () => {
    const p = await product("res-a", { sku: "C1", name: "Cost 100", price: 20000, cost: 10000 });
    const z = await product("res-a", { sku: "Z1", name: "Cost 0", price: 15000, cost: 0 });
    const riza = await reseller("Riza");
    const tenant = tenantDb(world.db, "res-a");
    // Reseller sale: ₱250 to the customer, ₱50 Riza's.
    const r = ok(await sell(riza.token, [{ productId: p, quantity: Q(1), sellingPrice: 25000 }]), 201);
    await fulfill(orderIdOf(r.orderNumber));
    let rep = await reportOf();
    expect(rep.overview).toMatchObject({ grossSales: 25000, cogs: 10000, estimatedOperatingProfit: 15000, resellerCommission: 5000, ownerSales: 20000, ownerNetProfit: 10000 });
    // A direct sale of the ₱0-COGS product: all of it is the owner's.
    const direct = await createOrder({ db: world.db, tenant, FieldValue, business: BIZ, entitlements: docAt("businesses/res-a").entitlements, input: { customer: { name: "Walk-in", phone: "", notes: "" }, source: "walk_in", items: [{ productId: z, quantity: Q(1) }] }, idempotencyKey: key(), actor: setup, canDiscount: false, now: NOW });
    await fulfill(direct.orderId);
    // An operating expense of ₱30.
    await createExpense({ db: world.db, tenant, FieldValue, business: BIZ, workspace: "reseller", input: { date: "2026-10-15", category: "packaging", amount: 3000, method: "cash" }, actor: setup, now: NOW });
    rep = await reportOf();
    // ₱200 owner revenue + ₱150 direct − ₱100 COGS − ₱30 expenses = ₱220.
    expect(rep.overview).toMatchObject({ grossSales: 40000, netSales: 40000, cogs: 10000, operatingExpenses: 3000, resellerCommission: 5000, ownerSales: 35000, ownerNetProfit: 22000 });
    const day = rep.series.find((s) => s.period === "2026-10-15");
    expect(day).toMatchObject({ netProfit: 27000, resellerCommission: 5000, ownerNetProfit: 22000 });
  });

  it("an Owner override: the owner keeps what the reseller doesn't (₱150 → ₱120: owner revenue ₱380 of ₱500); partial customer payment doesn't change the fulfilled-sale basis", async () => {
    const p1 = await product("res-a", { sku: "P1", name: "Product 1", price: 20000, cost: 10000 });
    const p2 = await product("res-a", { sku: "P2", name: "Product 2", price: 15000, cost: 0 });
    const riza = await reseller("Riza");
    const r = ok(await sell(riza.token, [{ productId: p1, quantity: Q(1), sellingPrice: 25000 }, { productId: p2, quantity: Q(1), sellingPrice: 25000 }]), 201);
    const orderId = orderIdOf(r.orderNumber);
    ok(await owner({ action: "editSale", orderId, finalCommission: 12000 }));
    await customerPays(orderId, 20000); // 40% paid
    await fulfill(orderId);
    const rep = await reportOf();
    // Sales are booked at fulfillment (Luna's existing basis); the owner's share
    // of what's still unpaid is a receivable, as for any order.
    expect(rep.overview).toMatchObject({ grossSales: 50000, cogs: 10000, resellerCommission: 12000, ownerSales: 38000, ownerNetProfit: 28000, paymentsReceived: 20000 });
    // The commission report is separate: ₱48 earned so far.
    expect(ok(await owner({ action: "report", from: "2026-10-01", to: "2026-10-31" })).report.total).toBe(4800);
  });

  it("open (unfulfilled) and cancelled reseller orders add nothing; a Distributor report has no owner-profit fields; Staff without money access see none", async () => {
    const p = await product("res-a", { sku: "C1", name: "Cost 100", price: 20000, cost: 10000 });
    const riza = await reseller("Riza");
    const open = ok(await sell(riza.token, [{ productId: p, quantity: Q(1), sellingPrice: 25000 }]), 201);
    const gone = ok(await sell(riza.token, [{ productId: p, quantity: Q(1), sellingPrice: 25000 }]), 201);
    await cancelOrder({ db: world.db, tenant: tenantDb(world.db, "res-a"), FieldValue, business: BIZ, orderId: orderIdOf(gone.orderNumber), reason: "Customer backed out", actor: setup });
    expect(open.orderNumber).toBeTruthy();
    const rep = await reportOf();
    expect(rep.overview.resellerCommission ?? 0).toBe(0);
    expect(rep.overview.ownerNetProfit ?? null).toBe(rep.overview.estimatedOperatingProfit ?? null);
    const res = await createReportsHandler(deps())({ ...request({ uid: world.uids.ownera, businessId: "biz-a" }), queryStringParameters: { from: "2026-10-01", to: "2026-10-15" } });
    expect(JSON.parse(res.body).overview).not.toHaveProperty("ownerNetProfit");
    const staff = await createReportsHandler(deps())({ ...request({ uid: world.uids["staff-res-a"], businessId: "res-a" }), queryStringParameters: { from: "2026-10-01", to: "2026-10-15" } });
    if (staff.statusCode === 200) expect(JSON.stringify(JSON.parse(staff.body).overview)).not.toMatch(/ownerNetProfit|resellerCommission/);
  });
});

describe("recompute earned totals saved under the old rule (2026-11-01 migration)", () => {
  it("earned = Σ (final × verified ÷ total); dry run changes nothing; never below what's paid (blocked)", async () => {
    const { recomputeEarned } = await import("../../netlify/functions/_lib/resellers.js");
    const tenant = tenantDb(world.db, "res-a");
    const a = await product("res-a", { sku: "M1", name: "Migrate", price: 20000 });
    const riza = await reseller("Riza");
    const yanie = await reseller("Yanie");
    const r1 = orderIdOf(ok(await sell(riza.token, [{ productId: a, quantity: Q(2), sellingPrice: 25000 }]), 201).orderNumber); // ₱100 potential, ₱500
    await customerPays(r1, 20000); // 40% → ₱40
    orderIdOf(ok(await sell(yanie.token, [{ productId: a, quantity: Q(1), sellingPrice: 30000 }]), 201).orderNumber); // ₱100, unpaid
    // As stored before 2026-11-01: the full commission at order time, and a payout of it.
    world.db.seed(`businesses/res-a/resellers/${riza.id}`, { ...docAt(`businesses/res-a/resellers/${riza.id}`), earned: 10000 });
    world.db.seed(`businesses/res-a/resellers/${yanie.id}`, { ...docAt(`businesses/res-a/resellers/${yanie.id}`), earned: 10000, paid: 10000 });
    const dry = await recomputeEarned({ db: world.db, tenant, FieldValue, resellerId: riza.id, actor: setup });
    expect(dry).toMatchObject({ before: 10000, after: 4000, potential: 10000, changed: true, blocked: false });
    expect(docAt(`businesses/res-a/resellers/${riza.id}`).earned).toBe(10000);
    expect(await recomputeEarned({ db: world.db, tenant, FieldValue, resellerId: riza.id, apply: true, actor: setup })).toMatchObject({ after: 4000, applied: true });
    expect(docAt(`businesses/res-a/resellers/${riza.id}`).earned).toBe(4000);
    const y = await recomputeEarned({ db: world.db, tenant, FieldValue, resellerId: yanie.id, apply: true, actor: setup });
    expect(y).toMatchObject({ before: 10000, after: 0, paid: 10000, blocked: true });
    expect(y.applied).toBeUndefined();
    expect(docAt(`businesses/res-a/resellers/${yanie.id}`).earned).toBe(10000);
    // Then later payments keep it exact.
    await customerPays(r1, 30000);
    expect((await summary(riza.id)).earned).toBe(10000);
  });
});
