// Owner pilot: the public menu / order link. The slug resolves to ONE
// business; the public sees only what a menu needs; a customer's order is
// a normal Luna order from the same engine (reserved, pending, unpaid,
// source "Online store"); staff are notified; abuse is limited; another
// tenant is never reachable.

import { describe, it, expect, beforeEach } from "vitest";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createStorefrontHandler } from "../../netlify/functions/storefront.js";
import { createStoreHandler } from "../../netlify/functions/store.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";
import { publicOrderInput, validateStoreSettings, defaultStoreSettings } from "../../shared/storefront.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-setup", name: "Setup", email: "" };
let NOW = new Date("2026-10-18T02:00:00Z");
let world;
let k = 0;
const key = () => `store-key-${String(++k).padStart(10, "0")}`;

beforeEach(async () => {
  NOW = new Date("2026-10-18T02:00:00Z");
  world = await buildWorld();
});

const deps = () => ({ getAdmin: async () => world, now: () => NOW });
async function owner(uid, body, businessId = "biz-a") {
  const res = await createStorefrontHandler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function pub(body, ip = "203.0.113.7") {
  const res = await createStoreHandler(deps())({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": ip }, body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const docAt = (p) => world.db.docs.get(p);
const docsUnder = (prefix) => [...world.db.docs.entries()].filter(([p]) => p.startsWith(prefix)).map(([p, d]) => ({ path: p, ...d }));

async function stocked(businessId, { sku, name, price = 7500, cost = 5000, qty = 20, category = "Coffee" }) {
  const tenant = tenantDb(world.db, businessId);
  const { productId } = await createProduct({ db: world.db, tenant, FieldValue, actor, input: { sku, name, unit: "pcs", sellingPrice: price, reorderLevel: 0, category } });
  if (qty > 0) await recordMovement({ db: world.db, tenant, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(qty), unitCost: cost, note: "count" } });
  return productId;
}
async function openStore(extra = {}) {
  const got = ok(await owner(world.uids.ownera, { action: "get" }));
  ok(await owner(world.uids.ownera, { action: "save", settings: { open: true, pickup: true, delivery: true, paymentMethods: ["cod", "gcash"], ...extra } }));
  return got.settings.slug;
}
const ORDER = (items, extra = {}) => ({ name: "Marian Santos", phone: "0917 123 4567", fulfillment: "delivery", address: "12 Mabini St, Taguig", paymentMethod: "gcash", notes: "Gate is blue", items, ...extra });

describe("the Owner's link and settings", () => {
  it("a link name is made from the business name on first use; closed by default; Staff can see it, only settings.manage can change it", async () => {
    const got = ok(await owner(world.uids.ownera, { action: "get" }));
    expect(got).toMatchObject({ path: "/store/biz-a", canManage: true, settings: { slug: "biz-a", open: false, displayName: "Biz A", pickup: true, delivery: false } });
    expect(docAt("storeSlugs/biz-a")).toMatchObject({ businessId: "biz-a" });
    expect(ok(await owner(world.uids.staffa, { action: "get" }))).toMatchObject({ path: "/store/biz-a", canManage: false });
    expect(ok(await owner(world.uids.managera, { action: "get" })).canManage).toBe(false);
    expect((await owner(world.uids.staffa, { action: "save", settings: { open: true } })).status).toBe(403);
    expect((await owner(world.uids.managera, { action: "save", settings: { open: true } })).status).toBe(403);
    expect((await owner(world.uids.ownera, { action: "save", settings: { open: true, prices: {} } })).status).toBe(400);
    expect((await owner(world.uids.ownera, { action: "save", settings: { pickup: false, delivery: false } })).status).toBe(400);
    const saved = ok(await owner(world.uids.ownera, { action: "save", settings: { open: true, displayName: "Biz A Coffee", note: "Orders before 3pm ship today" } }));
    expect(saved.settings).toMatchObject({ open: true, displayName: "Biz A Coffee", slug: "biz-a" });
    expect(docsUnder("businesses/biz-a/auditLog/").some((a) => a.type === "storefront.settings_updated" && a.changed.includes("open"))).toBe(true);
  });

  it("each business has its own link; a name another store holds is refused; renaming frees the old link at once", async () => {
    ok(await owner(world.uids.ownerb, { action: "get" }, "biz-b"));
    expect(docAt("storeSlugs/biz-b")).toMatchObject({ businessId: "biz-b" });
    expect((await owner(world.uids.ownera, { action: "save", settings: { slug: "biz-b" } })).status).toBe(409);
    const slug = await openStore();
    expect(ok(await pub({ action: "view", slug })).store.open).toBe(true);
    ok(await owner(world.uids.ownera, { action: "save", settings: { slug: "biz-a-coffee" } }));
    expect((await pub({ action: "view", slug: "biz-a" })).status).toBe(404);
    expect(docAt("storeSlugs/biz-a")).toBeUndefined();
    expect(ok(await pub({ action: "view", slug: "biz-a-coffee" })).store.name).toBe("Biz A");
    expect((await owner(world.uids.ownera, { action: "save", settings: { slug: "Bad Slug!" } })).status).toBe(400);
  });
});

describe("the public menu", () => {
  it("unknown / closed stores; an open store shows only visible active products with a price, never costs, SKUs or stock levels", async () => {
    expect((await pub({ action: "view", slug: "no-such-store" })).status).toBe(404);
    expect((await pub({ action: "view", slug: "../biz-a" })).status).toBe(404);
    ok(await owner(world.uids.ownera, { action: "get" }));
    expect(ok(await pub({ action: "view", slug: "biz-a" }))).toMatchObject({ store: { open: false }, products: [] });

    const kopi = await stocked("biz-a", { sku: "HAYST-KOPI", name: "Hayst Kopi", qty: 20 });
    const choco = await stocked("biz-a", { sku: "HAYST-CHOCO", name: "Hayst Choco", qty: 3 });
    const gone = await stocked("biz-a", { sku: "MATCHA", name: "Matcha", qty: 0 });
    const secret = await stocked("biz-a", { sku: "STAFF-MEAL", name: "Staff meal", qty: 5 });
    await stocked("biz-a", { sku: "FREE", name: "Free sample", price: 0, qty: 5 });
    await openStore({ hiddenProductIds: [secret] });
    const v = ok(await pub({ action: "view", slug: "biz-a" }));
    expect(v.store).toMatchObject({ name: "Biz A", open: true, pickup: true, delivery: true, paymentMethods: ["cod", "gcash"], currency: "PHP" });
    expect(v.products.map((p) => p.name)).toEqual(["Hayst Choco", "Hayst Kopi", "Matcha"]);
    const by = Object.fromEntries(v.products.map((p) => [p.id, p]));
    expect(by[kopi]).toEqual({ id: kopi, name: "Hayst Kopi", category: "Coffee", unit: "pcs", unitLabel: by[kopi].unitLabel, price: 7500, soldOut: false, left: null, max: Q(99) });
    expect(by[choco]).toMatchObject({ soldOut: false, left: Q(3), max: Q(3) }); // "Only 3 left"
    expect(by[gone]).toMatchObject({ soldOut: true, max: 0 });
    const text = JSON.stringify(v);
    for (const leak of ["HAYST-KOPI", "onHand", "reserved", "averageCost", "5000", "Staff meal", "biz-b", "ownera"]) expect(text).not.toContain(leak);
  });

  it("a suspended or cancelled business has no public store", async () => {
    for (const [bid, uid] of [["biz-s", "owners"], ["biz-x", "ownerx"]]) {
      const tenant = tenantDb(world.db, bid);
      await world.db.collection("storeSlugs").doc(`${bid}-shop`).set({ businessId: bid });
      await tenant.doc("storefront", "settings").set({ ...defaultStoreSettings({ name: bid }), slug: `${bid}-shop`, open: true });
      expect((await pub({ action: "view", slug: `${bid}-shop` })).status, uid).toBe(404);
    }
  });
});

describe("a customer's order = a normal Luna order", () => {
  it("server prices, reservation, pending + unpaid, source Online store, delivery / payment choice kept; staff notified; a retry is the same order", async () => {
    const kopi = await stocked("biz-a", { sku: "HAYST-KOPI", name: "Hayst Kopi", qty: 20 });
    const choco = await stocked("biz-a", { sku: "HAYST-CHOCO", name: "Hayst Choco", qty: 12 });
    const slug = await openStore();
    const idem = key();
    const body = { action: "order", slug, idempotencyKey: idem, order: ORDER([{ productId: kopi, quantity: Q(2) }, { productId: choco, quantity: Q(1) }]) };
    const r = ok(await pub(body), 201);
    expect(r.order).toMatchObject({ total: 22500, currency: "PHP", replayed: false, sourceNote: "Delivery · GCash" });
    expect(r.order.items.map((l) => [l.name, l.quantity, l.lineSubtotal])).toEqual([["Hayst Kopi", Q(2), 15000], ["Hayst Choco", Q(1), 7500]]);
    expect(r.order.orderNumber).toMatch(/^ORD-20261018-\d{3}$/);

    const orders = docsUnder("businesses/biz-a/orders/");
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ source: "online_store", sourceNote: "Delivery · GCash", deliveryAddress: "12 Mabini St, Taguig", notes: "Gate is blue", customer: { name: "Marian Santos", phone: "0917 123 4567" }, customerId: null, discount: 0, total: 22500, paymentStatus: "unpaid", fulfillmentStatus: "pending", createdBy: { uid: "online-store", name: "Online store" } });
    expect(docAt(`businesses/biz-a/products/${kopi}`)).toMatchObject({ reserved: Q(2), available: Q(18) });
    expect(docAt("businesses/biz-a/metrics/2026-10-18").orderCount).toBe(1);
    // Staff who fulfil orders hear about it (the owner here).
    const inbox = docsUnder(`businesses/biz-a/members/${world.uids.ownera}/inbox/`).filter((n) => n.type === "order.online");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ title: `New online order ${r.order.orderNumber}` });

    // The same submit again (a double tap / flaky network): the same order.
    const again = ok(await pub(body));
    expect(again.order).toMatchObject({ orderNumber: r.order.orderNumber, replayed: true, total: 22500 });
    expect(docsUnder("businesses/biz-a/orders/")).toHaveLength(1);
    expect(docAt(`businesses/biz-a/products/${kopi}`).reserved).toBe(Q(2));
  });

  it("refuses forged prices / discounts / customer links, hidden or unknown products, too much, missing details, a closed store and bots", async () => {
    const kopi = await stocked("biz-a", { sku: "HAYST-KOPI", name: "Hayst Kopi", qty: 4 });
    const secret = await stocked("biz-a", { sku: "SECRET", name: "Secret", qty: 4 });
    const slug = await openStore({ hiddenProductIds: [secret] });
    const send = (order, extra = {}) => pub({ action: "order", slug, idempotencyKey: key(), order, ...extra });
    const line = [{ productId: kopi, quantity: Q(1) }];
    expect((await send({ ...ORDER(line), discount: 7500 })).status).toBe(400);
    expect((await send({ ...ORDER(line), customerId: "abcdefgh12" })).status).toBe(400);
    expect((await send(ORDER([{ productId: kopi, quantity: Q(1), unitPrice: 1 }]))).status).toBe(400);
    expect((await send(ORDER([{ productId: secret, quantity: Q(1) }]))).status).toBe(400);
    expect((await send(ORDER([{ productId: "nosuchproduct1", quantity: Q(1) }]))).status).toBe(409);
    expect((await send(ORDER([{ productId: kopi, quantity: Q(5) }]))).status).toBe(409); // only 4
    expect((await send(ORDER(line, { address: "" }))).status).toBe(400); // delivery needs an address
    expect((await send(ORDER(line, { phone: "12" }))).status).toBe(400);
    expect((await send(ORDER(line, { name: " " }))).status).toBe(400);
    expect((await send(ORDER(line, { paymentMethod: "maya" }))).status).toBe(400); // not offered
    expect((await send(ORDER(line), { website: "http://spam" })).status).toBe(400);
    expect(docsUnder("businesses/biz-a/orders/")).toHaveLength(0);
    expect(docAt(`businesses/biz-a/products/${kopi}`).reserved).toBe(0);
    ok(await owner(world.uids.ownera, { action: "save", settings: { open: false } }));
    expect((await send(ORDER(line))).status).toBe(409);
  });

  it("rate limits: 5 orders per client per 10 minutes; another client is unaffected; the window resets", async () => {
    const kopi = await stocked("biz-a", { sku: "HAYST-KOPI", name: "Hayst Kopi", qty: 50 });
    const slug = await openStore();
    const send = (ip) => pub({ action: "order", slug, idempotencyKey: key(), order: ORDER([{ productId: kopi, quantity: Q(1) }]) }, ip);
    for (let i = 0; i < 5; i++) ok(await send("198.51.100.1"), 201);
    expect((await send("198.51.100.1")).status).toBe(429);
    ok(await send("198.51.100.2"), 201);
    NOW = new Date(NOW.getTime() + 11 * 60 * 1000);
    ok(await send("198.51.100.1"), 201);
    // The client address is never stored in clear.
    expect(JSON.stringify(docsUnder("storeThrottle/"))).not.toContain("198.51.100");
  });

  it("tenant isolation: a store's link only ever orders from its own business", async () => {
    const a = await stocked("biz-a", { sku: "A-1", name: "A product", qty: 5 });
    const b = await stocked("biz-b", { sku: "B-1", name: "B product", qty: 5 });
    const slug = await openStore();
    expect((await pub({ action: "order", slug, idempotencyKey: key(), order: ORDER([{ productId: b, quantity: Q(1) }]) })).status).toBe(409);
    expect(docsUnder("businesses/biz-b/orders/")).toHaveLength(0);
    expect(docAt(`businesses/biz-b/products/${b}`).reserved).toBe(0);
    ok(await pub({ action: "order", slug, idempotencyKey: key(), order: ORDER([{ productId: a, quantity: Q(1) }]) }), 201);
    expect(docsUnder("businesses/biz-b/orders/")).toHaveLength(0);
  });
});

describe("shared rules", () => {
  it("pickup-only stores don't ask; payment choice only when offered; the source note says how", () => {
    const s = { ...defaultStoreSettings({ name: "X" }), pickup: true, delivery: false, paymentMethods: [] };
    const o = publicOrderInput({ name: "Ana", phone: "09171234567", items: [{ productId: "abcdefgh12", quantity: 1000 }] }, s);
    expect(o).toMatchObject({ source: "online_store", sourceNote: "Pickup", deliveryAddress: "", customer: { name: "Ana", phone: "09171234567" } });
    expect(() => publicOrderInput({ name: "Ana", phone: "09171234567", fulfillment: "delivery", address: "x", items: [{ productId: "abcdefgh12", quantity: 1000 }] }, s)).toThrow(/pickup only/);
    expect(() => validateStoreSettings({ paymentMethods: ["other"] }, s)).toThrow();
  });
});
