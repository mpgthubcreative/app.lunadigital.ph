// Reseller Package (2026-10-31): resellers by name only, a private menu link
// per reseller (no Luna account), selling price over the owner price, the
// commission (calculated vs final), payouts as a ledger (Unpaid / Partially
// Paid / Paid), the simple report, and isolation: a link sees only its own
// reseller, a business only its own resellers.

import { describe, it, expect, beforeEach } from "vitest";
import { createProduct, recordMovement, updateProduct } from "../../netlify/functions/_lib/inventory.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { createResellersHandler } from "../../netlify/functions/resellers.js";
import { createResellerMenuHandler } from "../../netlify/functions/reseller-menu.js";
import { createPayHandler } from "../../netlify/functions/pay.js";
import { createOrdersHandler } from "../../netlify/functions/orders.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { createOrder, cancelOrder, updateOrder } from "../../netlify/functions/_lib/orders.js";
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
    expect(v.commission).toEqual({ earned: 0, paid: 0, remaining: 0, status: "none" });
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
    expect(await summary(riza.id)).toMatchObject({ earned: 30000, paid: 0, remaining: 30000, payoutStatus: "unpaid" });
    // Stock: one business inventory (reserved like any order).
    expect(docAt(`businesses/res-a/products/${a}`).available).toBe(Q(48));
    // Her own orders, read-only.
    const mine = ok(await menu({ action: "view", token: riza.token })).orders;
    expect(mine).toEqual([expect.objectContaining({ orderNumber: r.orderNumber, total: 130000, ownerAmount: 100000, commission: 30000, payout: "unpaid", paymentStatus: "unpaid", fulfillmentStatus: "pending" })]);
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
  async function rizaSale(sellingPrice = 65000, qty = 2) {
    const a = await product("res-a", { sku: `A${++k}`, name: "Product A", price: 50000 });
    const riza = await reseller("Riza");
    const r = ok(await sell(riza.token, [{ productId: a, quantity: Q(qty), sellingPrice }]), 201);
    const [path, order] = [...world.db.docs.entries()].find(([p, d]) => p.startsWith("businesses/res-a/orders/") && d.orderNumber === r.orderNumber);
    return { a, riza, orderId: path.split("/").pop(), order };
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
    const { riza, orderId } = await rizaSale();
    ok(await owner({ action: "pay", resellerId: riza.id, idempotencyKey: key(), payout: { amount: 10000 } }), 201);
    ok(await owner({ action: "editSale", orderId, finalCommission: 25000 }));
    expect(await summary(riza.id)).toMatchObject({ earned: 25000, paid: 10000, remaining: 15000, payoutStatus: "partial" });
    ok(await owner({ action: "pay", resellerId: riza.id, idempotencyKey: key(), payout: { amount: 15000 } }), 201);
    expect((await owner({ action: "editSale", orderId, finalCommission: 20000 })).body).toMatchObject({ error: "commission-below-paid" });
    // Cancelling the order would also leave a negative balance: refused the same way.
    const tenant = tenantDb(world.db, "res-a");
    await expect(cancelOrder({ db: world.db, tenant, FieldValue, business: { timezone: "Asia/Manila" }, orderId, reason: "Customer backed out", actor: setup })).rejects.toMatchObject({ code: "commission-below-paid" });
    const payoutId = ok(await owner({ action: "detail", resellerId: riza.id })).payouts.find((p) => p.amount === 15000).id;
    expect((await owner({ action: "reversePayout", payoutId, reason: "x" })).status).toBe(400);
    ok(await owner({ action: "reversePayout", payoutId, reason: "Paid twice by mistake" }));
    ok(await owner({ action: "editSale", orderId, finalCommission: 20000 }));
    const d = ok(await owner({ action: "detail", resellerId: riza.id }));
    expect(d.reseller).toMatchObject({ earned: 20000, paid: 10000, remaining: 10000, payoutStatus: "partial" });
    expect(d.payouts.find((p) => p.id === payoutId)).toMatchObject({ state: "reversed", reversal: { reason: "Paid twice by mistake" } });
  });

  it("an order edit keeps the owner price snapshot and an override; a new price later never rewrites history; cancel releases the commission", async () => {
    const { a, riza, orderId } = await rizaSale();
    const tenant = tenantDb(world.db, "res-a");
    // November: the owner raises the price; October's order keeps ₱500.
    await updateProduct({ db: world.db, tenant, FieldValue, productId: a, changes: { sellingPrice: 55000 }, actor: setup });
    await updateOrder({ db: world.db, tenant, FieldValue, orderId, input: { customer: { name: "Marian Santos", phone: "", notes: "" }, source: "other", sourceNote: "Reseller · Riza", items: [{ productId: a, quantity: Q(3) }] }, actor: setup, canDiscount: false });
    let o = docAt(`businesses/res-a/orders/${orderId}`);
    expect(o.items[0]).toMatchObject({ unitPrice: 65000, basePrice: 50000, commission: 45000 });
    expect(o.commission).toMatchObject({ calculated: 45000, final: 45000, adjusted: false });
    expect((await summary(riza.id)).earned).toBe(45000);
    ok(await owner({ action: "editSale", orderId, finalCommission: 40000 }));
    await updateOrder({ db: world.db, tenant, FieldValue, orderId, input: { customer: { name: "Marian Santos", phone: "", notes: "" }, source: "other", sourceNote: "Reseller · Riza", items: [{ productId: a, quantity: Q(2) }] }, actor: setup, canDiscount: false });
    o = docAt(`businesses/res-a/orders/${orderId}`);
    expect(o.commission).toMatchObject({ calculated: 30000, final: 40000, adjusted: true }); // the override survives
    // Back to calculated, then cancel: nothing earned.
    ok(await owner({ action: "editSale", orderId, finalCommission: null }));
    expect((await summary(riza.id)).earned).toBe(30000);
    await cancelOrder({ db: world.db, tenant, FieldValue, business: { timezone: "Asia/Manila" }, orderId, reason: "Customer backed out", actor: setup });
    expect(await summary(riza.id)).toMatchObject({ earned: 0, payoutStatus: "none" });
  });

  it("editSale: selling price (open orders), another reseller, Direct Sale; below the owner price needs an explicit final commission", async () => {
    const { riza, orderId } = await rizaSale();
    const yanie = await reseller("Yanie");
    const line = docAt(`businesses/res-a/orders/${orderId}`).items[0].lineId;
    ok(await owner({ action: "editSale", orderId, prices: { [line]: 70000 } }));
    expect(docAt(`businesses/res-a/orders/${orderId}`)).toMatchObject({ total: 140000, commission: { calculated: 40000, final: 40000 } });
    expect((await owner({ action: "editSale", orderId, prices: { [line]: 45000 } })).body).toMatchObject({ error: "below-owner-price" });
    ok(await owner({ action: "editSale", orderId, prices: { [line]: 45000 }, finalCommission: 0 }));
    expect(docAt(`businesses/res-a/orders/${orderId}`).commission).toMatchObject({ calculated: -10000, final: 0, adjusted: true });
    ok(await owner({ action: "editSale", orderId, prices: { [line]: 65000 }, finalCommission: null }));
    ok(await owner({ action: "editSale", orderId, resellerId: yanie.id }));
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
    ok(await sell(riza.token, [{ productId: a, quantity: Q(1), sellingPrice: 60000 }]), 201);
    const rep = ok(await owner({ action: "report", from: "2026-10-01", to: "2026-10-31" })).report;
    expect(rep.total).toBe(10000);
    expect(rep.rows.map((r) => r.name)).toEqual(["Riza"]);
  });

  it("Today / this month / custom: earned by the order's date; an October commission paid in November stays October's", async () => {
    const a = await product("res-a", { sku: "A1", name: "Product A", price: 50000 });
    const riza = await reseller("Riza");
    const yanie = await reseller("Yanie");
    const veah = await reseller("Veah");
    NOW = new Date("2026-10-10T02:00:00Z");
    ok(await sell(riza.token, [{ productId: a, quantity: Q(2), sellingPrice: 65000 }]), 201); // ₱300
    ok(await sell(yanie.token, [{ productId: a, quantity: Q(3), sellingPrice: 65000 }]), 201); // ₱450
    NOW = new Date("2026-10-20T02:00:00Z");
    ok(await sell(veah.token, [{ productId: a, quantity: Q(5), sellingPrice: 60000 }]), 201); // ₱500
    ok(await owner({ action: "pay", resellerId: yanie.id, idempotencyKey: key(), payout: { amount: 45000, date: "2026-10-20" } }), 201);
    NOW = new Date("2026-11-02T02:00:00Z");
    ok(await owner({ action: "pay", resellerId: riza.id, idempotencyKey: key(), payout: { amount: 10000, date: "2026-11-02" } }), 201);
    ok(await sell(riza.token, [{ productId: a, quantity: Q(1), sellingPrice: 70000 }]), 201); // ₱200 in November
    const report = async (from, to) => ok(await owner({ action: "report", from, to })).report;
    const oct = await report("2026-10-01", "2026-10-31");
    expect(oct.total).toBe(125000);
    expect(oct.rows.map((r) => [r.name, r.earned, r.paid, r.remaining, r.status])).toEqual([["Veah", 50000, 0, 50000, "unpaid"], ["Yanie", 45000, 45000, 0, "paid"], ["Riza", 30000, 10000, 20000, "partial"]]);
    expect((await report("2026-11-01", "2026-11-02")).rows).toEqual([expect.objectContaining({ name: "Riza", earned: 20000, paid: 0, status: "unpaid" })]);
    expect((await report("2026-10-10", "2026-10-10")).total).toBe(75000);
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
    ok(await owner({ action: "pay", resellerId: riza.id, idempotencyKey: key(), payout: { amount: 10000, method: "gcash" } }), 201);
    const bytes = await workbook(world.uids["owner-res-a"], "res-a");
    expect(sheetNames(bytes)).toEqual(expect.arrayContaining(["Orders", "Resellers", "Commission Payouts"]));
    const orders = rows(bytes, "Orders");
    const head = orders[0];
    for (const h of ["Reseller", "Selling / Owner Price", "Owner Amount", "Calculated Commission", "Final Commission", "Commission Paid", "Commission Remaining", "Commission Status"]) expect(head).toContain(h);
    const line = orders.find((row) => row[0] === r.orderNumber);
    const col = (h) => line[head.indexOf(h)];
    expect(col("Reseller")).toBe("Riza");
    expect(col("Selling / Owner Price")).toBe("Product A @ ₱650.00 (owner ₱500.00)");
    expect([col("Owner Amount"), col("Calculated Commission"), col("Final Commission"), col("Commission Paid"), col("Commission Remaining")]).toEqual(["1000", "300", "250", "100", "150"]);
    expect(col("Commission Status")).toBe("Partially Paid");
    expect(rows(bytes, "Resellers")[1]).toEqual(["Riza", "Active", "250", "100", "150", "Partially Paid"]);
    expect(rows(bytes, "Commission Payouts")[1].slice(1, 4)).toEqual(["Riza", "100", "GCash"]);
  });

  it("a Distributor workbook is unchanged (no reseller columns or sheets)", async () => {
    const bytes = await workbook(world.uids.ownera, "biz-a");
    expect(sheetNames(bytes)).not.toContain("Resellers");
    expect(rows(bytes, "Orders")[0]).not.toContain("Reseller");
  });
});
